import type { Pool } from 'pg';
import { loadConfig, requireConfig, type Config } from '../config.js';
import {
  disableKnowledgeBinding,
  getKnowledgeBinding,
  listKnowledgeBindings,
  markKnowledgeBindingVerified,
  rebindKnowledgeBinding,
} from '../store/knowledgeBindings.js';
import { AgentKitKnowledgeProvider } from '../providers/agentkitKnowledge.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Knowledge verification bootstraps the deployment attestation, so only this
 * operator command family parses configuration with the runtime provider gate
 * disabled. All database, credential, network, and production checks remain.
 */
export function loadKnowledgeAdminConfig(env: NodeJS.ProcessEnv): Config {
  return loadConfig({ ...env, KNOWLEDGE_PROVIDER: 'none' });
}

export async function runKnowledgeAdmin(
  pool: Pool,
  cfg: Config,
  action: string | undefined,
  args: string[],
): Promise<string> {
  if (action === 'bind') {
    const tenantId = args.find((a) => !a.startsWith('--'));
    const name = flag(args, 'name');
    const project = flag(args, 'project');
    const collection = flag(args, 'collection');
    if (!tenantId || !name || !project || !collection) {
      throw new Error(
        'usage: knowledge bind <tenantId> --name X --project X --collection X',
      );
    }
    const binding = await rebindKnowledgeBinding(pool, {
      tenantId,
      name,
      provider: 'agentkit',
      providerProject: project,
      providerCollection: collection,
    });
    return `knowledge binding ready for verification: ${binding.name} for tenant ${tenantId}\n`;
  }

  if (action === 'verify') {
    const tenantId = args.find((a) => !a.startsWith('--'));
    const name = flag(args, 'name');
    if (!tenantId || !name) {
      throw new Error('usage: knowledge verify <tenantId> --name X [--query X]');
    }
    const binding = await getKnowledgeBinding(pool, tenantId, name);
    if (!binding) throw new Error('knowledge binding is unavailable');
    const req = requireConfig(cfg, [
      'BYTEPLUS_ACCESS_KEY_ID',
      'BYTEPLUS_SECRET_ACCESS_KEY',
    ]);
    const provider = new AgentKitKnowledgeProvider(pool, {
      accessKeyId: req.BYTEPLUS_ACCESS_KEY_ID,
      secretAccessKey: req.BYTEPLUS_SECRET_ACCESS_KEY,
      sessionToken: cfg.BYTEPLUS_SESSION_TOKEN,
      requireLiveVerified: false,
    });
    await provider.retrieve({
      tenantId,
      reference: { name },
      query: flag(args, 'query') ?? 'contract verification',
      limit: 1,
    });
    if (
      !(await markKnowledgeBindingVerified(
        pool,
        tenantId,
        name,
        binding.revision,
      ))
    ) {
      throw new Error('knowledge binding changed during verification; retry');
    }
    return `knowledge binding live-verified: ${name} for tenant ${tenantId}\n`;
  }

  if (action === 'list') {
    const tenantId = args.find((a) => !a.startsWith('--'));
    if (!tenantId) throw new Error('usage: knowledge list <tenantId>');
    return JSON.stringify(await listKnowledgeBindings(pool, tenantId), null, 2) + '\n';
  }

  if (action === 'disable') {
    const [tenantId, name] = args.filter((a) => !a.startsWith('--'));
    if (!tenantId || !name) {
      throw new Error('usage: knowledge disable <tenantId> <name>');
    }
    const ok = await disableKnowledgeBinding(pool, tenantId, name);
    return ok ? `disabled ${name}\n` : `not found: ${name}\n`;
  }

  throw new Error(
    'usage: knowledge <bind|verify|list|disable> ...',
  );
}
