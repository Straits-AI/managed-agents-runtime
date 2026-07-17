# Managed Agents Runtime — Usage Guide

A practical guide to running the platform, driving agents through the API, and
operating it in production. For the architecture overview see the
[README](../README.md); for cost see [COST.md](./COST.md); for worked scenarios
see [COURSE-MATERIAL.md](./COURSE-MATERIAL.md) and [articles/](./articles/).

> **Built with the [byteplus-cloud skill](https://github.com/Straits-AI/byteplus-cloud-skill).**
> Every BytePlus resource in this project — ModelArk, veFaaS Cloud Sandbox, TOS,
> APIG, RDS PostgreSQL, VikingDB/Viking Memory, Message Queue for Kafka, and KMS —
> was provisioned and verified through that skill's operating contract
> (read-before-write, verify-after-write, least-privilege, cost disclosure).

---

## 1. Core model

```
AgentDefinition ──has many──▶ AgentVersion (immutable config: instructions,
                                            model policy, tools, verifier)
                                   │
                                   ▼
                                  Run  (a durable process: event ledger +
                                        attempts + workspace + checkpoints)
```

A **run** is the unit of work. It survives worker death, sandbox loss, and long
waits: all authoritative state is the append-only `run_events` ledger in
Postgres plus workspace checkpoints in TOS. Workers are disposable; a killed run
resumes on another worker from its last checkpoint, and committed external
actions never re-execute.

## 2. Run it locally (no BytePlus needed)

```bash
npm install
docker compose up -d          # local Postgres on :5433
npm run migrate
npm test                      # full suite against local Postgres

npm run api                   # control-plane API on :8080
npm run worker                # harness worker (WORKER_EPOCH=scripted for no-model runs)
npm run relay                 # outbox relay (PUBLISHER=inproc by default)
```

Everything runs with the local providers (child-process sandbox, filesystem
object store) — no cloud credentials required. To connect real BytePlus
services, copy `.env.example` to `.env` and fill it in (see the README's
"Connecting to BytePlus" table).

## 3. Drive an agent through the API

All requests need `Authorization: Bearer <token>`. The configured
`API_AUTH_TOKEN` authenticates as the built-in `default` tenant; per-tenant API
keys (below) authenticate as their own tenant.

```bash
TOKEN=dev-token
# 1. Create an agent + an immutable version
AID=$(curl -s -XPOST localhost:8080/v1/agents -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"researcher"}' | jq -r .id)
VID=$(curl -s -XPOST localhost:8080/v1/agents/$AID/versions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"instructions":"Research the question and write a report.",
       "modelPolicy":{"model":"seed-2.0-lite","escalationModel":"seed-1.6"},
       "grants":[]}' | jq -r .id)

# 2. Start a run (optionally with capability grants, budgets)
RID=$(curl -s -XPOST localhost:8080/v1/runs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"agentVersionId\":\"$VID\",\"goal\":\"Summarize X\",
       \"maxSteps\":40,\"tokenBudget\":2000000,
       \"grants\":[{\"action\":\"external.http.request\",\"resource\":\"https://api.example.com\",\"maxCalls\":10}]}" \
  | jq -r .id)

# 3. Watch it — long-poll or stream
curl -s "localhost:8080/v1/runs/$RID/events?afterSeq=0&wait=30000" -H "authorization: Bearer $TOKEN"
curl -sN "localhost:8080/v1/runs/$RID/events/stream" -H "authorization: Bearer $TOKEN"   # SSE

# 4. Inspect + control
curl -s localhost:8080/v1/runs/$RID -H "authorization: Bearer $TOKEN"           # status + attempts
curl -s localhost:8080/v1/runs/$RID/usage -H "authorization: Bearer $TOKEN"     # tokens + est. cost
curl -s localhost:8080/v1/runs/$RID/artifacts -H "authorization: Bearer $TOKEN" # workspace revisions
curl -XPOST localhost:8080/v1/runs/$RID/messages -d '{"message":"also check Y"}' ...
curl -XPOST localhost:8080/v1/runs/$RID/cancel ...
```

### Endpoint reference

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/agents`, `/v1/agents/:id/versions` | define agents/versions |
| POST | `/v1/runs` | start a run (grants, `maxSteps`, `tokenBudget`, `scheduledFor`) |
| GET | `/v1/runs/:id` | run + attempts |
| GET | `/v1/runs/:id/events` | long-poll (`afterSeq`, `wait`≤30s) |
| GET | `/v1/runs/:id/events/stream` | **SSE** live stream (`Last-Event-ID` resume) |
| POST | `/v1/runs/:id/messages` | inject a user message |
| POST | `/v1/runs/:id/signals` | deliver an external signal (wakes `wait_for_signal`) |
| GET/POST | `/v1/runs/:id/approvals[/:aid]` | list / approve-deny gated actions |
| POST | `/v1/runs/:id/cancel` | cancel (fences the live worker) |
| POST | `/v1/runs/:id/fork` | branch a new run from this run's checkpoint |
| GET | `/v1/runs/:id/usage`, `/v1/usage` | per-run / per-tenant tokens + cost |
| GET | `/v1/runs/:id/artifacts`, `/export` | workspace revisions / portable bundle |
| GET | `/healthz`, `/readyz` | liveness / readiness (unauthenticated) |

## 4. Multi-tenancy

```bash
npm run admin tenant create "Acme" --max-concurrent 20 --daily-tokens 50000000
npm run admin key create <tenantId> --name ci      # prints the key ONCE (mak_…)
npm run admin tenant list
```

Every run/agent is tenant-scoped; a cross-tenant id reads as **not-found** (no
existence leak). Quotas (`max_concurrent_runs`, `daily_token_budget`) return
`429` when exceeded. The operator `API_AUTH_TOKEN` maps to the `default` tenant.

## 5. Credential broker (secrets in tool calls, never in the model)

Agents call external systems without the model ever seeing the secret: the broker
injects a scoped header into the outbound request only.

```bash
# Local encrypted key (dev):
export CREDENTIAL_PROVIDER=local
export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Or BytePlus KMS (prod): create a key, then
#   CREDENTIAL_PROVIDER=kms, KMS_KEYRING_NAME=<ring>, KMS_KEY_NAME=<key>
#   bp kms CreateKeyring --KeyringName <ring>; bp kms CreateKey --KeyringName <ring> --KeyName <key>

npm run admin credential create <tenantId> \
  --name github --action external.http.request \
  --resource https://api.github.com --header Authorization \
  --value "Bearer ghp_…" --max-uses 100
```

At tool time, a run with a matching capability **grant** for the action+resource
gets the credential injected (verified by tenant + action + resource + expiry +
call-limit). The secret is stored encrypted (AES-256-GCM locally, or KMS
ciphertext) and never enters model context, tool results, or the audit ledger.

## 6. Event fan-out (Kafka)

The transactional outbox records every event; the `relay` process drains it to a
publisher. Default is in-process (consumers read the ledger via the API). For
external fan-out, point it at Kafka:

```bash
export PUBLISHER=kafka
export KAFKA_BROKERS=<host:port>            # prefer the private hostname endpoint
export KAFKA_TOPIC=run_events
export KAFKA_SASL_USERNAME=… KAFKA_SASL_PASSWORD=…
export KAFKA_SSL=1                          # KAFKA_SSL_REJECT_UNAUTHORIZED=0 only for a
                                            # public endpoint that advertises brokers by IP
npm run relay
```

Delivery is at-least-once and de-duplicated across relays (`FOR UPDATE SKIP
LOCKED`). Messages are keyed by run id, so a run's events stay ordered within a
partition.

## 7. Operations

- **Health:** `/healthz` (liveness), `/readyz` (checks DB) — unauthenticated, for
  load balancers/k8s probes.
- **Logging:** structured JSON to stdout/stderr; set `LOG_LEVEL`.
- **Rate limiting:** per-tenant token bucket; `RATE_LIMIT_SCOPE=global` uses a
  shared Postgres bucket across API instances.
- **Shutdown:** SIGTERM drains in-flight work bounded by `SHUTDOWN_TIMEOUT_MS`.
- **Cost:** `/usage` reports estimated model cost; see [COST.md](./COST.md).

## 8. Best practices

- **Least authority.** Grant only the `action`+`resource` a run needs, with
  `maxCalls` and (for risky writes) `requiresApproval`. Subagents inherit less,
  never more.
- **Cap spend.** Always set `tokenBudget` and `maxSteps`. The semantic supervisor
  detects loops/stagnation and terminates a stuck run instead of burning budget;
  keep it enabled (`SUPERVISOR_ENABLED=1`).
- **Let runs wait.** Model long human/approval/event delays as
  `WAITING_APPROVAL`/`WAITING_SIGNAL` — waiting holds **zero** compute, only
  storage. Don't poll-loop an agent.
- **Adaptive models.** Default to a cheap model; set `escalationModel` so the
  supervisor only pays for a stronger one on stuck steps.
- **Verify completion.** Use the verifier policy (deterministic checks first) so
  "done" means acceptance criteria met, not just the model claiming so.
- **Secrets via the broker, not the prompt.** Never put credentials in
  instructions or tool arguments; register them with the broker.
- **Tenant isolation.** One API key per tenant; never share the operator token
  externally. Set quotas per tenant.
- **Durability, not memory.** Recovery restores from the ledger + checkpoints —
  never ask the model to reconstruct what happened.

## 9. Deploying on BytePlus

Map (per the byteplus-cloud skill's service selection): control API + workers +
harness → veFaaS; sandbox → Cloud Sandbox; state → RDS PostgreSQL; artifacts →
TOS; model → ModelArk; event bus → Message Queue for Kafka; secrets → KMS;
memory/knowledge → AgentKit (VikingDB). Provisioning + credential helpers are in
[`scripts/`](../scripts) and [`infra/resources.md`](../infra/resources.md); run
`npm run preflight` to check every surface. **Note:** some BytePlus services need
a one-time console **activation** (KMS) or **service-linked-role** authorization
(Kafka's `ServiceRoleForKafka`) before their APIs work — these are console-only.
