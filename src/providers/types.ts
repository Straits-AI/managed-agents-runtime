// Kernel-facing provider interfaces (memo §21). The kernel depends only on
// these; BytePlus implementations live beside them and other providers can
// be added without touching the kernel.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string; // for role: 'tool'
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ModelProvider {
  chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{
    message: ChatMessage;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

export interface SandboxHandle {
  sandboxId: string;
  /** Base URL of the in-sandbox REST API (without instance routing). */
  baseUrl: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxProvider {
  create(req: {
    runId: string;
    timeoutMinutes: number;
    image?: string;
    envs?: Record<string, string>;
    cpuMilli?: number;
    memoryMB?: number;
  }): Promise<SandboxHandle>;
  exec(
    handle: SandboxHandle,
    command: string,
    opts?: { timeoutSec?: number; cwd?: string },
  ): Promise<ExecResult>;
  writeFile(handle: SandboxHandle, path: string, content: string): Promise<void>;
  readFile(handle: SandboxHandle, path: string): Promise<string>;
  describe(handle: SandboxHandle): Promise<{ status: string }>;
  terminate(handle: SandboxHandle): Promise<void>;
}

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<{ etag: string | null }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  presignPut(key: string, ttlSec: number): Promise<string>;
  presignGet(key: string, ttlSec: number): Promise<string>;
}
