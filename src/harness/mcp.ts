import type {
  McpToolExecutionPolicy,
  McpToolProvider,
  ToolDef,
} from '../providers/types.js';
import type { ActionClassification } from './governedAction.js';

/** Route entry for a resolved MCP tool: which toolset + its original name. */
export interface McpRouteEntry {
  toolsetRef: string;
  originalName: string;
  classification: ActionClassification;
  recovery: 'read' | 'idempotent' | 'reconcile' | 'manual';
}

const PREFIX = 'mcp__';

function validateExecutionPolicy(value: unknown): McpToolExecutionPolicy {
  if (!value || typeof value !== 'object') {
    throw new Error('MCP tool execution policy is missing or malformed');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.classification === 'read') return { classification: 'read' };
  if (
    candidate.classification === 'mutation' &&
    (candidate.recovery === 'idempotent' ||
      candidate.recovery === 'reconcile' ||
      candidate.recovery === 'manual')
  ) {
    return {
      classification: 'mutation',
      recovery: candidate.recovery,
    };
  }
  throw new Error('MCP tool execution policy has an invalid classification or recovery mode');
}

/**
 * Resolve the tools exposed by an agent version's MCP toolset refs into model
 * ToolDefs (namespaced `mcp__<toolset>__<tool>` so they never collide with
 * built-in tools) plus a route map the tool router uses to dispatch calls back
 * through the MCP provider (memo §9.2). The model sees MCP tools alongside
 * built-ins, but every call still flows through our capability/audit layer.
 */
export async function resolveMcpTools(
  provider: McpToolProvider | undefined,
  toolsetRefs: string[],
): Promise<{ defs: ToolDef[]; route: Map<string, McpRouteEntry> }> {
  const defs: ToolDef[] = [];
  const route = new Map<string, McpRouteEntry>();
  if (!provider) return { defs, route };

  for (const ref of toolsetRefs) {
    const tools = await provider.listTools(ref).catch(() => []);
    for (const t of tools) {
      const policy = validateExecutionPolicy(
        await provider.getToolExecutionPolicy(ref, t.name),
      );
      const namespaced = `${PREFIX}${ref}__${t.name}`;
      defs.push({ ...t, name: namespaced });
      route.set(namespaced, {
        toolsetRef: ref,
        originalName: t.name,
        classification: policy.classification,
        recovery: policy.classification === 'read' ? 'read' : policy.recovery,
      });
    }
  }
  return { defs, route };
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}
