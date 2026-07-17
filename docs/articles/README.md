# Tutorial articles — Managed Agents in production

Each article walks one real-world deployment end to end, with the **actual**
input prompt, the agent’s real message-by-message execution, and the verified
output — captured from live runs on BytePlus. Source captures:
[`scenarios/results/`](../../scenarios/results/).

- **[SRE agent — incident triage with human-approved remediation](./sre-incident.md)** — Autonomous on-call that can act on production — safely
- **[Support agent — policy-driven refund with money-movement approval](./support-refund.md)** — Support automation where the agent can move money — exactly once
- **[Accounts-payable agent — invoice ↔ purchase-order reconciliation](./invoice-reconcile.md)** — Accounts-payable matching with machine-actionable output
- **[DevSecOps agent — dependency vulnerability audit with objective gate](./dep-audit.md)** — DevSecOps where the verifier is itself a security control
- **[Data-engineering agent — messy CSV cleaning with schema gate](./etl-clean.md)** — Data pipelines with the data contract enforced automatically

## How these were produced

Every article is generated from a live run by [`scenarios/make-articles.ts`](../../scenarios/make-articles.ts): the input comes from the scenario definition, the message exchange from the TOS-persisted transcript, and the output from the captured result. Nothing is hand-edited into the transcripts — the agent messages are exactly what ran.