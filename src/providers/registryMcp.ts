import type { McpToolProvider, ToolDef } from './types.js';

export interface RegisteredMcpTool {
  def: ToolDef;
  handler: (args: Record<string, unknown>) => Promise<string> | string;
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

  async callTool(
    toolsetRef: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string }> {
    const tool = (this.toolsets.get(toolsetRef) ?? []).find((t) => t.def.name === name);
    if (!tool) return { content: `error: MCP tool ${name} not found in toolset ${toolsetRef}` };
    return { content: String(await tool.handler(args)) };
  }
}
