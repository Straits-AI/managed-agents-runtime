import type { McpToolProvider, ToolDef } from '../providers/types.js';

/** Route entry for a resolved MCP tool: which toolset + its original name. */
export interface McpRouteEntry {
  toolsetRef: string;
  originalName: string;
}

const PREFIX = 'mcp__';

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
      const namespaced = `${PREFIX}${ref}__${t.name}`;
      defs.push({ ...t, name: namespaced });
      route.set(namespaced, { toolsetRef: ref, originalName: t.name });
    }
  }
  return { defs, route };
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}
