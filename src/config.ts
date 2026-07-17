import { z } from 'zod';

const intFromEnv = (def: number) =>
  z.coerce.number().int().positive().default(def);

const configSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:5433/managed_agents'),
  API_AUTH_TOKEN: z.string().default('dev-token'),
  API_PORT: intFromEnv(8080),

  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().default('https://ark.ap-southeast.bytepluses.com/api/v3'),
  ARK_MODEL: z.string().optional(),

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

  WORKER_ID: z.string().default(`worker-${process.pid}`),
  LEASE_TTL_MS: intFromEnv(30_000),
  HEARTBEAT_MS: intFromEnv(10_000),
  POLL_MS: intFromEnv(1_000),
  MAX_ATTEMPTS: intFromEnv(5),
  CHECKPOINT_EVERY_STEPS: intFromEnv(5),

  HARNESS_ENABLE_FAULTS: z.coerce.number().int().min(0).max(1).default(0),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
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
