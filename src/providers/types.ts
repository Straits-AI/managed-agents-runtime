// Kernel-facing provider interfaces (memo §21). The kernel depends only on
// these; BytePlus implementations live beside them and other providers can
// be added without touching the kernel.

import type { CredentialReleaseRequest } from '../core/credentials.js';

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
  annotations?: { readOnlyHint?: boolean };
}

export interface ModelProvider {
  chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
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

/**
 * Long-term agent memory (memo §9.3, §21): semantic/episodic facts that persist
 * across runs — recalled into context and written by the agent. NOT
 * authoritative execution state (that is the Run Ledger). The kernel depends
 * only on this interface; the Postgres and AgentKit implementations are
 * interchangeable adapters.
 */
export interface MemoryRecord {
  id: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryScope {
  tenantId: string;
  agentId: string;
}

export interface MemoryProvider {
  /** Recall the most relevant memories for a scope, ranked against `query`. */
  search(scope: MemoryScope, query: string, limit: number): Promise<MemoryRecord[]>;
  /** Persist new memories for a scope. */
  write(
    scope: MemoryScope,
    entries: { content: string; kind?: string; metadata?: Record<string, unknown>; runId?: string }[],
  ): Promise<void>;
}

/**
 * Enterprise knowledge retrieval / RAG (memo §9.4, §21): the kernel retrieves
 * evidence from a knowledge base; Postgres and AgentKit Knowledge Base are
 * interchangeable adapters.
 */
export interface Evidence {
  id: string;
  title: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** Provider-neutral logical reference. Provider coordinates stay server-side. */
export interface KnowledgeReference {
  name: string;
}

export interface KnowledgeRetrieveRequest {
  tenantId: string;
  reference: KnowledgeReference;
  query: string;
  limit: number;
}

export interface KnowledgeProvider {
  retrieve(request: KnowledgeRetrieveRequest): Promise<Evidence[]>;
}

/**
 * Reusable, filesystem-based Skills (memo §9.1, §21): procedural know-how
 * (how to review a repo, prepare a memo, run a deploy) materialized into the
 * run's workspace. A version-pinned ref resolves to an immutable set of files —
 * a run must never silently receive a different skill version after resuming.
 */
export interface SkillRef {
  provider: string; // e.g. 'registry' | 'agentkit'
  skillSpace?: string;
  skill: string;
  version: string; // pinned; never 'latest'
}

export interface ResolvedSkill {
  name: string;
  version: string;
  description?: string;
  /** workspace-relative path -> file content */
  files: Record<string, string>;
}

export interface SkillProvider {
  resolve(ref: SkillRef): Promise<ResolvedSkill>;
}

/**
 * MCP toolsets (memo §9.2): external tools reached through an MCP gateway. The
 * kernel discovers a toolset's tools and routes calls — but the model never
 * invokes them directly; calls flow through the capability/audit layer. Local
 * and AgentKit MCP gateways are interchangeable adapters.
 */
export interface McpToolProvider {
  listTools(toolsetRef: string): Promise<ToolDef[]>;
  callTool(
    toolsetRef: string,
    name: string,
    args: Record<string, unknown>,
    context: {
      idempotencyKey: string;
      credential: { headerName: string; headerValue: string } | null;
    },
  ): Promise<{ content: string }>;
}

/**
 * Event transport (memo §10/§11). The transactional outbox records every run
 * event; a relay drains it and hands batches to an EventPublisher. The default
 * in-process publisher is a no-op drain (consumers read the event ledger via the
 * API); a Kafka/RocketMQ adapter is the seam for fanning events out to external
 * subscribers. `OutboxRow` is structurally assignable to `PublishableEvent`.
 */
export interface PublishableEvent {
  id: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
}
export interface EventPublisher {
  publish(events: PublishableEvent[]): Promise<void>;
}

/**
 * Credential broker (memo §9.5, §19 layer 5). Releases a scoped secret to a
 * run's outbound tool call after verifying the request. The returned header is
 * injected into the tool adapter's request and MUST never enter the model
 * context, tool arguments, results, or the audit ledger. Returns null when no
 * credential is authorized for the request. Local (encrypted store) and KMS
 * adapters are interchangeable.
 */
export interface CredentialProvider {
  resolve(input: CredentialReleaseRequest): Promise<{
    headerName: string;
    headerValue: string;
  } | null>;
}
