import { z } from 'zod';

const intFromEnv = (def: number) =>
  z.coerce.number().int().positive().default(def);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:5433/managed_agents'),
  // Operator token → the built-in 'default' tenant. Per-tenant API keys (mak_…)
  // authenticate as their own tenant; see src/api/auth.ts.
  API_AUTH_TOKEN: z.string().default('dev-token'),
  // Loopback by default. Deployments that intentionally expose the API must opt
  // in with API_HOST=0.0.0.0 (or another explicit interface address).
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: intFromEnv(8080),
  // Max request body size (bytes). Bounds memory per request.
  API_BODY_LIMIT_BYTES: intFromEnv(1_048_576),
  // SSE event stream (GET /v1/runs/:id/events/stream): keep-alive heartbeat
  // interval and a hard cap on how long one stream stays open.
  SSE_HEARTBEAT_MS: intFromEnv(15_000),
  SSE_MAX_STREAM_MS: intFromEnv(1_800_000),
  // Per-tenant token-bucket rate limit: RATE_LIMIT_PER_SEC sustained, with a
  // RATE_LIMIT_BURST bucket. Set RATE_LIMIT_PER_SEC=0 to disable.
  RATE_LIMIT_PER_SEC: z.coerce.number().min(0).default(20),
  RATE_LIMIT_BURST: intFromEnv(40),
  // 'instance' (default) = in-process bucket per API node; 'global' = a shared
  // Postgres bucket enforced across all API instances.
  RATE_LIMIT_SCOPE: z.enum(['instance', 'global']).default('instance'),
  // Max time to drain in-flight work on SIGTERM/SIGINT before forcing exit.
  SHUTDOWN_TIMEOUT_MS: intFromEnv(15_000),

  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().default('https://ark.ap-southeast.bytepluses.com/api/v3'),
  ARK_MODEL: z.string().optional(),
  // Stronger model the semantic supervisor routes to when a stuck run is
  // escalated (memo §25). Per-agent `model_policy.escalationModel` overrides it.
  ESCALATION_MODEL: z.string().optional(),
  // Cost attribution (memo §25 / Phase 2). USD per MILLION tokens; defaults are
  // BytePlus ModelArk Seed-2.0-lite ($0.25/M input, $2.00/M output). Override
  // per deployment/model. Used by /usage cost estimates — not billing-authoritative.
  MODEL_PRICE_INPUT_PER_MTOK: z.coerce.number().min(0).default(0.25),
  MODEL_PRICE_OUTPUT_PER_MTOK: z.coerce.number().min(0).default(2.0),

  BYTEPLUS_ACCESS_KEY_ID: z.string().optional(),
  BYTEPLUS_SECRET_ACCESS_KEY: z.string().optional(),
  // Set when using STS temporary credentials (e.g. synced from `bp login`
  // via scripts/refresh-creds.py). Empty/absent for long-term IAM keys.
  BYTEPLUS_SESSION_TOKEN: z.string().optional(),
  BYTEPLUS_OPENAPI_HOST: z.string().default('open.byteplusapi.com'),
  BYTEPLUS_REGION: z.string().default('ap-southeast-1'),
  VEFAAS_SANDBOX_FUNCTION_ID: z.string().optional(),
  SANDBOX_IMAGE: z.string().optional(),
  // Required alongside SANDBOX_IMAGE only when overriding the app's image
  // per-run; the API rejects an image override without a startup command.
  SANDBOX_STARTUP_COMMAND: z.string().optional(),
  SANDBOX_TIMEOUT_MINUTES: intFromEnv(60),
  // APIG serverless-gateway route fronting the sandbox app. Set the domain to
  // skip APIG discovery; the API key satisfies the route's Key Auth plugin
  // (sent as the Authorization header the plugin is configured to read).
  SANDBOX_GATEWAY_DOMAIN: z.string().optional(),
  SANDBOX_GATEWAY_API_KEY: z.string().optional(),

  TOS_ENDPOINT: z.string().default('tos-ap-southeast-1.bytepluses.com'),
  TOS_REGION: z.string().default('ap-southeast-1'),
  TOS_BUCKET: z.string().optional(),

  AGENTKIT_MCP_URL: z.string().optional(),
  AGENTKIT_MCP_API_KEY: z.string().optional(),
  // Long-term memory backend: 'pg' (Postgres, default), 'agentkit' (Viking
  // Memory), or 'none' to disable cross-run memory.
  MEMORY_PROVIDER: z.enum(['pg', 'agentkit', 'none']).default('pg'),
  // Viking Memory collection name, required when MEMORY_PROVIDER=agentkit.
  AGENTKIT_MEMORY_COLLECTION: z.string().optional(),
  // Knowledge backend: 'pg' (Postgres, default), 'agentkit' (Knowledge Base),
  // or 'none'.
  KNOWLEDGE_PROVIDER: z.enum(['pg', 'agentkit', 'none']).default('pg'),
  // Credential broker (memo §9.5): 'local' = encrypted Postgres store (needs
  // CREDENTIAL_ENCRYPTION_KEY, a base64 32-byte AES-256 key); 'none' disables
  // credential injection (default). Injected secrets never reach model context.
  CREDENTIAL_PROVIDER: z.enum(['local', 'kms', 'none']).default('none'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  // BytePlus KMS key for CREDENTIAL_PROVIDER=kms (encrypt/decrypt under a CMK).
  KMS_KEYRING_NAME: z.string().optional(),
  KMS_KEY_NAME: z.string().optional(),

  WORKER_ID: z.string().default(`worker-${process.pid}`),
  LEASE_TTL_MS: intFromEnv(30_000),
  HEARTBEAT_MS: intFromEnv(10_000),
  POLL_MS: intFromEnv(1_000),
  MAX_ATTEMPTS: intFromEnv(5),
  CHECKPOINT_EVERY_STEPS: intFromEnv(5),

  // Semantic supervisor (memo §25). Watches each run for loops/stagnation and
  // escalates through corrective note → stronger model → terminate so a run
  // cannot spin forever burning budget.
  SUPERVISOR_ENABLED: z.coerce.number().int().min(0).max(1).default(1),
  SUPERVISOR_LOOP_THRESHOLD: intFromEnv(3),
  SUPERVISOR_STAGNATION_STEPS: intFromEnv(5),
  SUPERVISOR_WINDOW: intFromEnv(8),
  SUPERVISOR_MAX_ESCALATIONS: intFromEnv(2),
  // Fraction of step/token budget below which budget-aware wind-down kicks in.
  SUPERVISOR_BUDGET_HEADROOM: z.coerce.number().min(0).max(1).default(0.15),
  // Subagent replacement (memo §25, Phase 5B): how many times a failed delegated
  // child is replaced with a fresh attempt before the parent resumes with the
  // failure. 0 disables replacement (a failed child wakes the parent directly).
  MAX_CHILD_REPLACEMENTS: z.coerce.number().int().min(0).default(1),

  // Event transport (memo §10/§11). The relay (npm run relay) drains the
  // transactional outbox to this publisher. 'inproc' (default) is a no-op drain
  // — external consumers read the event ledger via the API; 'kafka' is the
  // broker seam (needs a client + provisioned queue). Relay loop cadence + batch.
  PUBLISHER: z.enum(['inproc', 'kafka']).default('inproc'),
  RELAY_POLL_MS: intFromEnv(1_000),
  RELAY_BATCH: intFromEnv(100),
  // Kafka publisher (PUBLISHER=kafka). Brokers is comma-separated host:port.
  // Public BytePlus Kafka endpoints use SASL/PLAIN over SSL.
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_TOPIC: z.string().default('run_events'),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  KAFKA_SSL: z.coerce.number().int().min(0).max(1).default(1),
  // Verify the broker TLS cert. Keep 1 in production (connect via the private
  // hostname endpoint, whose cert matches). Set 0 only for a managed public
  // endpoint that advertises brokers by IP (cert altname mismatch).
  KAFKA_SSL_REJECT_UNAUTHORIZED: z.coerce.number().int().min(0).max(1).default(1),

  HARNESS_ENABLE_FAULTS: z.coerce.number().int().min(0).max(1).default(0),
});

export type Config = z.infer<typeof configSchema>;

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  const isProduction = parsed.data.NODE_ENV === 'production';
  const isExposed = !isLoopbackHost(parsed.data.API_HOST);
  if (isProduction || isExposed) {
    const boundary = isProduction ? 'production' : 'exposed API';
    const configuredToken = env.API_AUTH_TOKEN?.trim();
    if (isProduction && (!configuredToken || configuredToken === 'dev-token')) {
      throw new Error(
        'Unsafe production configuration: API_AUTH_TOKEN must be explicitly set',
      );
    }
    if (!configuredToken || configuredToken.length < 32) {
      throw new Error(
        `Unsafe ${boundary} configuration: API_AUTH_TOKEN must contain at least 32 non-whitespace characters`,
      );
    }
    if (parsed.data.HARNESS_ENABLE_FAULTS !== 0) {
      throw new Error(
        `Unsafe ${boundary} configuration: HARNESS_ENABLE_FAULTS must be disabled`,
      );
    }
  }
  return parsed.data;
}

/** Throws unless every key named in `keys` is present in the config. */
export function requireConfig<K extends keyof Config>(
  cfg: Config,
  keys: K[],
): { [P in K]: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => cfg[k] === undefined || cfg[k] === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')} — see .env.example`,
    );
  }
  return cfg as { [P in K]: NonNullable<Config[P]> };
}
