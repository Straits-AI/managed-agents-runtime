import type { Pool } from 'pg';
import type { ProgressLedger, RunRow } from '../core/types.js';
import type { AgentVersionRow } from '../store/agents.js';
import type { ChatMessage, MemoryRecord } from '../providers/types.js';
import type { CapabilityGrantRow } from '../store/grants.js';
import { WORKSPACE_DIR } from './workspace.js';

/** Max transcript messages replayed into context before truncation. */
const TRANSCRIPT_TAIL = 60;

/**
 * Assemble model context (memo §16.1). The model never sees the raw event
 * history — it gets the goal, the durable progress ledger, capability
 * grants, queued user messages, and the recent transcript tail.
 */
export function compileContext(input: {
  version: AgentVersionRow;
  run: RunRow;
  grants: CapabilityGrantRow[];
  transcript: ChatMessage[];
  userMessages: string[];
  approvalOutcomes: { action: string; decision: string }[];
  memories?: MemoryRecord[];
  skills?: { name: string; version: string; description?: string; path: string }[];
  toolDocs: string;
}): ChatMessage[] {
  const { version, run } = input;

  const system = [
    version.instructions,
    '',
    '# Execution environment',
    'You are a durable agent process. Your work happens in a Linux sandbox',
    `with a persistent ${WORKSPACE_DIR} directory that survives sandbox loss.`,
    'Work step by step using the available tools. Keep the progress ledger',
    'up to date with progress.update — it is how your work survives',
    'interruption. When the goal is fully achieved, call run.complete.',
    '',
    '# Tools',
    input.toolDocs,
    '',
    ...(input.skills && input.skills.length > 0
      ? [
          '',
          '# Skills available (materialized into your workspace)',
          ...input.skills.map(
            (s) => `- ${s.name} v${s.version}${s.description ? ` — ${s.description}` : ''} (at ${s.path})`,
          ),
        ]
      : []),
    '',
    '# Capabilities granted to this run',
    input.grants.length > 0
      ? input.grants
          .map(
            (g) =>
              `- ${g.action_pattern} on ${g.resource_pattern}` +
              (g.requires_approval ? ' (requires human approval)' : '') +
              (g.max_calls !== null ? ` (max ${g.max_calls} calls)` : ''),
          )
          .join('\n')
      : '- none beyond built-in workspace tools',
  ].join('\n');

  const progress = run.progress as ProgressLedger;
  const memories = input.memories ?? [];
  const userParts = [
    memories.length > 0
      ? `# What you remember (long-term memory from past runs)\n${memories
          .map((m) => `- [${m.kind}] ${m.content}`)
          .join('\n')}`
      : null,
    `# Goal\n${run.goal}`,
    Object.keys(progress).length > 0
      ? `# Progress ledger (your durable state)\n${JSON.stringify(progress, null, 2)}`
      : null,
    input.approvalOutcomes.length > 0
      ? `# Approval decisions since you last ran\n${input.approvalOutcomes
          .map((a) => `- ${a.action}: ${a.decision}`)
          .join('\n')}`
      : null,
    input.userMessages.length > 0
      ? `# New user messages\n${input.userMessages.map((m) => `- ${m}`).join('\n')}`
      : null,
    `Remaining budget: ${run.max_steps} total steps for this run.`,
  ].filter((p): p is string => p !== null);

  const tail =
    input.transcript.length > TRANSCRIPT_TAIL
      ? [
          {
            role: 'user' as const,
            content: `[${input.transcript.length - TRANSCRIPT_TAIL} earlier transcript messages truncated — rely on the progress ledger]`,
          },
          ...input.transcript.slice(-TRANSCRIPT_TAIL),
        ]
      : input.transcript;

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n') },
    ...tail,
  ];
}
