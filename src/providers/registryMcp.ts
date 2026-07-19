import type {
  McpCallContext,
  McpReconciliationResult,
  McpToolExecutionPolicy,
  McpToolProvider,
  McpToolResult,
  ToolDef,
} from './types.js';

export type { McpCallContext } from './types.js';

export async function* mcpText(content: string): AsyncIterable<string> {
  yield content;
}

/** Tool handlers never receive transport credentials; only the provider adapter does. */
export type RegisteredMcpCallContext = Omit<McpCallContext, 'credential'>;

export interface RegisteredMcpTool {
  def: ToolDef;
  execution?: McpToolExecutionPolicy;
  handler: (
    args: Record<string, unknown>,
    context: RegisteredMcpCallContext,
  ) => Promise<McpToolResult> | McpToolResult;
  reconcile?: (
    args: Record<string, unknown>,
    context: RegisteredMcpCallContext,
  ) => Promise<McpReconciliationResult> | McpReconciliationResult;
}

/**
 * In-process MCP toolset registry (the default McpToolProvider): register a
 * toolset's tools + handlers, resolved by toolset ref. Swap for an AgentKit MCP
 * gateway adapter (remote toolsets) without touching the kernel.
 */
export class RegistryMcpProvider implements McpToolProvider {
  private readonly toolsets = new Map<string, RegisteredMcpTool[]>();

  registerToolset(ref: string, tools: RegisteredMcpTool[]): this {
    this.toolsets.set(ref, tools);
    return this;
  }

  async listTools(toolsetRef: string): Promise<ToolDef[]> {
    return (this.toolsets.get(toolsetRef) ?? []).map((t) => t.def);
  }

  async getToolExecutionPolicy(
    toolsetRef: string,
    name: string,
  ): Promise<McpToolExecutionPolicy> {
    const tool = this.findTool(toolsetRef, name);
    if (!tool) {
      return { classification: 'mutation', recovery: 'manual' };
    }
    return tool.execution ?? (tool.def.annotations?.readOnlyHint === true
      ? { classification: 'read' }
      : { classification: 'mutation', recovery: 'manual' });
  }

  async callTool(
    toolsetRef: string,
    name: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const tool = this.findTool(toolsetRef, name);
    if (!tool) return { content: mcpText(`error: MCP tool ${name} not found in toolset ${toolsetRef}`) };
    const { credential: _credential, ...handlerContext } = context;
    return tool.handler(args, handlerContext);
  }

  async reconcileTool(
    toolsetRef: string,
    name: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpReconciliationResult> {
    const tool = this.findTool(toolsetRef, name);
    if (!tool?.reconcile) return { status: 'unknown' };
    const { credential: _credential, ...handlerContext } = context;
    return tool.reconcile(args, handlerContext);
  }

  private findTool(toolsetRef: string, name: string): RegisteredMcpTool | undefined {
    return (this.toolsets.get(toolsetRef) ?? []).find((tool) => tool.def.name === name);
  }
}
