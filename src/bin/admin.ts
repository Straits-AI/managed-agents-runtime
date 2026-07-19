/**
 * Operator CLI for tenant + API-key administration.
 *
 *   node --env-file=.env --import tsx src/bin/admin.ts tenant create "Acme" \
 *        [--max-concurrent 10] [--daily-tokens 5000000] [--id acme]
 *   node --env-file=.env --import tsx src/bin/admin.ts key create <tenantId> [--name "ci"]
 *   node --env-file=.env --import tsx src/bin/admin.ts tenant list
 *   node --env-file=.env --import tsx src/bin/admin.ts knowledge bind <tenantId>
 *        --name <logical> --project <providerProject> --collection <providerCollection>
 *
 * A minted key's plaintext is printed exactly once — it is never stored or
 * recoverable. Store it somewhere safe immediately.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createTenant, createApiKey } from '../store/tenants.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Build the secret cipher matching the deployment's CREDENTIAL_PROVIDER. */
async function buildCipher(cfg: import('../config.js').Config) {
  const { requireConfig } = await import('../config.js');
  if (cfg.CREDENTIAL_PROVIDER === 'kms') {
    const req = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
      'KMS_KEYRING_NAME',
      'KMS_KEY_NAME',
    ]);
    const { KmsClient } = await import('../providers/byteplus/kmsClient.js');
    const { KmsCipher } = await import('../providers/byteplus/kmsCipher.js');
    return new KmsCipher(
      new KmsClient({
        accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
        secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
        sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
        host: cfg.BYTEPLUS_OPENAPI_HOST,
        region: cfg.BYTEPLUS_REGION,
        keyringName: req.KMS_KEYRING_NAME,
        keyName: req.KMS_KEY_NAME,
      }),
    );
  }
  const { loadKey } = await import('../crypto.js');
  const { LocalCipher } = await import('../providers/secretCipher.js');
  const req = requireConfig(cfg, ['CREDENTIAL_ENCRYPTION_KEY']);
  return new LocalCipher(loadKey(req.CREDENTIAL_ENCRYPTION_KEY));
}

async function main(): Promise<void> {
  const [, , resource, action, ...rest] = process.argv;
  // Knowledge administration is the bootstrap path that establishes live
  // verification. It must remain runnable while production workers/APIs are
  // correctly refusing KNOWLEDGE_PROVIDER=agentkit. For these commands only,
  // parse all credentials/database settings with the runtime provider off.
  const cfg = loadConfig(
    resource === 'knowledge'
      ? { ...process.env, KNOWLEDGE_PROVIDER: 'none' }
      : process.env,
  );
  const pool = createPool(cfg.DATABASE_URL);

  try {
    if (resource === 'tenant' && action === 'create') {
      const name = rest.find((a) => !a.startsWith('--'));
      if (!name) throw new Error('usage: tenant create <name> [--id X] [--max-concurrent N] [--daily-tokens N]');
      const maxc = flag(rest, 'max-concurrent');
      const daily = flag(rest, 'daily-tokens');
      const tenant = await createTenant(pool, {
        name,
        id: flag(rest, 'id'),
        quota: {
          maxConcurrentRuns: maxc ? Number(maxc) : undefined,
          dailyTokenBudget: daily ? Number(daily) : undefined,
        },
      });
      process.stdout.write(`tenant created: ${tenant.id} (${tenant.name})\n`);
    } else if (resource === 'tenant' && action === 'list') {
      const { rows } = await pool.query(
        'SELECT id, name, status, max_concurrent_runs, daily_token_budget FROM tenants ORDER BY created_at',
      );
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    } else if (resource === 'key' && action === 'create') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      if (!tenantId) throw new Error('usage: key create <tenantId> [--name X]');
      const { id, plaintext } = await createApiKey(pool, { tenantId, name: flag(rest, 'name') });
      process.stdout.write(
        `api key created: ${id} for tenant ${tenantId}\n` +
          `\n  ${plaintext}\n\n` +
          `Store this now — it is shown once and cannot be recovered.\n`,
      );
    } else if (resource === 'credential' && action === 'create') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      const name = flag(rest, 'name');
      const act = flag(rest, 'action');
      const header = flag(rest, 'header');
      const value = flag(rest, 'value');
      if (!tenantId || !name || !act || !header || !value) {
        throw new Error(
          'usage: credential create <tenantId> --name X --action <pattern> --header <HeaderName> --value <secret> [--resource <pattern>] [--max-uses N] [--expires <ISO>]',
        );
      }
      const { createCredential } = await import('../store/credentials.js');
      const cipher = await buildCipher(cfg);
      const maxUses = flag(rest, 'max-uses');
      const cred = await createCredential(pool, {
        tenantId,
        name,
        action: act,
        resource: flag(rest, 'resource'),
        headerName: header,
        secret: value,
        cipher,
        maxUses: maxUses ? Number(maxUses) : undefined,
        expiresAt: flag(rest, 'expires'),
      });
      process.stdout.write(`credential created: ${cred.id} for tenant ${tenantId} (secret stored encrypted, not recoverable)\n`);
    } else if (resource === 'credential' && action === 'list') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      if (!tenantId) throw new Error('usage: credential list <tenantId>');
      const { listCredentials } = await import('../store/credentials.js');
      process.stdout.write(JSON.stringify(await listCredentials(pool, tenantId), null, 2) + '\n');
    } else if (resource === 'credential' && action === 'revoke') {
      const [id, tenantId] = rest.filter((a) => !a.startsWith('--'));
      if (!id || !tenantId) throw new Error('usage: credential revoke <credentialId> <tenantId>');
      const { revokeCredential } = await import('../store/credentials.js');
      const ok = await revokeCredential(pool, id, tenantId);
      process.stdout.write(ok ? `revoked ${id}\n` : `not found: ${id}\n`);
    } else if (resource === 'knowledge' && action === 'bind') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      const name = flag(rest, 'name');
      const project = flag(rest, 'project');
      const collection = flag(rest, 'collection');
      if (!tenantId || !name || !project || !collection) {
        throw new Error(
          'usage: knowledge bind <tenantId> --name X --project X --collection X',
        );
      }
      const { createKnowledgeBinding } = await import('../store/knowledgeBindings.js');
      const binding = await createKnowledgeBinding(pool, {
        tenantId,
        name,
        provider: 'agentkit',
        providerProject: project,
        providerCollection: collection,
      });
      process.stdout.write(`knowledge binding created: ${binding.name} for tenant ${tenantId}\n`);
    } else if (resource === 'knowledge' && action === 'verify') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      const name = flag(rest, 'name');
      if (!tenantId || !name) {
        throw new Error('usage: knowledge verify <tenantId> --name X [--query X]');
      }
      const { requireConfig } = await import('../config.js');
      const req = requireConfig(cfg, [
        'BYTEPLUS_ACCESS_KEY_ID',
        'BYTEPLUS_SECRET_ACCESS_KEY',
      ]);
      const { AgentKitKnowledgeProvider } = await import(
        '../providers/agentkitKnowledge.js'
      );
      const provider = new AgentKitKnowledgeProvider(pool, {
        accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
        secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
        sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
        requireLiveVerified: false,
      });
      await provider.retrieve(name, flag(rest, 'query') ?? 'contract verification', 1, tenantId);
      const { markKnowledgeBindingVerified } = await import(
        '../store/knowledgeBindings.js'
      );
      if (!(await markKnowledgeBindingVerified(pool, tenantId, name))) {
        throw new Error('knowledge binding is unavailable');
      }
      process.stdout.write(`knowledge binding live-verified: ${name} for tenant ${tenantId}\n`);
    } else if (resource === 'knowledge' && action === 'list') {
      const tenantId = rest.find((a) => !a.startsWith('--'));
      if (!tenantId) throw new Error('usage: knowledge list <tenantId>');
      const { listKnowledgeBindings } = await import('../store/knowledgeBindings.js');
      process.stdout.write(
        JSON.stringify(await listKnowledgeBindings(pool, tenantId), null, 2) + '\n',
      );
    } else if (resource === 'knowledge' && action === 'disable') {
      const [tenantId, name] = rest.filter((a) => !a.startsWith('--'));
      if (!tenantId || !name) {
        throw new Error('usage: knowledge disable <tenantId> <name>');
      }
      const { disableKnowledgeBinding } = await import('../store/knowledgeBindings.js');
      const ok = await disableKnowledgeBinding(pool, tenantId, name);
      process.stdout.write(ok ? `disabled ${name}\n` : `not found: ${name}\n`);
    } else {
      process.stderr.write(
        'usage:\n' +
          '  tenant create <name> [--id X] [--max-concurrent N] [--daily-tokens N]\n' +
          '  tenant list\n' +
          '  key create <tenantId> [--name X]\n' +
          '  credential create <tenantId> --name X --action <pattern> --header <H> --value <secret> [--resource <pattern>] [--max-uses N] [--expires <ISO>]\n' +
          '  credential list <tenantId>\n' +
          '  credential revoke <credentialId> <tenantId>\n' +
          '  knowledge bind <tenantId> --name X --project X --collection X\n' +
          '  knowledge verify <tenantId> --name X [--query X]\n' +
          '  knowledge list <tenantId>\n' +
          '  knowledge disable <tenantId> <name>\n',
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

await main();
