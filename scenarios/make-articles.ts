/**
 * Generate standalone tutorial articles (docs/articles/<id>.md) from the
 * captured scenario data: the scenario definition (input), the persisted model
 * transcript (the agent's real input/output messages), and the result JSON
 * (artifacts, external actions, receipts). Narrative framing per article is
 * authored inline below.
 *
 *   node --import tsx scenarios/make-articles.ts
 */
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './cases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'scenarios', 'results');
const OUT = join(ROOT, 'docs', 'articles');

interface Msg {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: { name: string; arguments: unknown }[];
}

/** Per-article editorial framing. */
const ARTICLES: Record<
  string,
  { subtitle: string; problem: string; whyPlatform: string; takeaway: string }
> = {
  'sre-incident': {
    subtitle: 'Autonomous on-call that can act on production — safely',
    problem:
      'On-call engineers spend nights reading logs, matching symptoms to runbooks, and running ' +
      'remediation commands. An AI agent can do the reading and the matching in seconds — but the ' +
      '*acting* part is terrifying without guardrails: an agent that scales the wrong service or ' +
      'fires a remediation twice can turn a small incident into an outage.',
    whyPlatform:
      'The runtime lets the agent diagnose freely but puts the one dangerous step — the remediation ' +
      'webhook — behind a capability grant that requires human approval, and guarantees it runs ' +
      'exactly once even if the worker crashes the instant after the call.',
    takeaway:
      'The agent read the log, matched the runbook, and proposed the exact remediation — then the ' +
      'platform paused for a human and executed the approved action once. That division of labour ' +
      '(agent reasons, platform governs) is what makes autonomous remediation deployable.',
  },
  'support-refund': {
    subtitle: 'Support automation where the agent can move money — exactly once',
    problem:
      'Refunds are the highest-value, highest-risk action a support agent takes. Automate them ' +
      'naively and two failure modes appear: the agent misapplies the policy, or a network retry ' +
      'issues the refund twice. Both are real money and real compliance incidents.',
    whyPlatform:
      'The agent applies the written policy and drafts the reply; the payout call is a governed, ' +
      'approval-gated action recorded against a durable idempotency key. A crash after the payout ' +
      'never re-issues it — the receipt already says COMMITTED.',
    takeaway:
      'One policy decision, one human approval, one payout — provably. This is the canonical case ' +
      'for a durable agent runtime over a plain agent framework.',
  },
  'invoice-reconcile': {
    subtitle: 'Accounts-payable matching with machine-actionable output',
    problem:
      'AP teams match every supplier invoice against its purchase order before paying. It is ' +
      'high-volume, arithmetic-heavy, and audit-sensitive — exactly the work that is tedious for ' +
      'humans and error-prone for a language model that "eyeballs" numbers.',
    whyPlatform:
      'The agent computes with real tools in the sandbox (not by guessing), and completion is gated ' +
      'on the output being valid, machine-readable JSON a downstream system can act on.',
    takeaway:
      'The agent caught both the quantity and price discrepancies with exact totals and emitted a ' +
      'structured verdict — ready to auto-approve the matching lines and route the two exceptions ' +
      'to a human.',
  },
  'dep-audit': {
    subtitle: 'DevSecOps where the verifier is itself a security control',
    problem:
      'Dependency remediation is easy to get subtly wrong: bump the wrong package, miss one, or ' +
      'declare success while a vulnerable version is still pinned. "The agent said it fixed it" is ' +
      'not an acceptable security posture.',
    whyPlatform:
      'The completion gate is a script that fails if *any* advisory-listed vulnerable version ' +
      'remains in the patched manifest. The run can only reach COMPLETED if that script passes — ' +
      'so the runtime, not the model, certifies the fix.',
    takeaway:
      'The agent patched exactly the vulnerable packages and left the rest alone, and the security ' +
      'gate independently confirmed no vulnerable version survived. Objective verification turns an ' +
      'agent into an auditable control.',
  },
  'etl-clean': {
    subtitle: 'Data pipelines with the data contract enforced automatically',
    problem:
      'Inbound data is messy — duplicates, missing fields, inconsistent casing and date formats. ' +
      'A cleaning agent is useful only if you can trust that its output actually conforms to your ' +
      'schema, every time.',
    whyPlatform:
      'The agent transforms with real Python in the sandbox, and a schema-validation script is the ' +
      'completion gate: wrong header, empty required fields, or un-normalised values reject the run.',
    takeaway:
      'The agent deduplicated, dropped incomplete rows, and normalised emails and dates — and the ' +
      'schema gate proved the cleaned dataset honours the contract before it is ever accepted.',
  },
};

function asText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  return JSON.stringify(c);
}

function renderConversation(transcript: Msg[]): string {
  const lines: string[] = [];
  let step = 1;
  for (const m of transcript) {
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      const thought = asText(m.content).trim();
      if (thought) lines.push(`**Agent (step ${step}):** ${thought}`, '');
      for (const call of calls) {
        lines.push(
          `**Agent → tool call:** \`${call.name}\``,
          '```json',
          JSON.stringify(call.arguments, null, 2),
          '```',
          '',
        );
      }
      step++;
    } else if (m.role === 'tool') {
      const out = asText(m.content);
      lines.push('**Tool result:**', '```', out.slice(0, 700) + (out.length > 700 ? '\n…' : ''), '```', '');
    }
  }
  return lines.join('\n');
}

fs.mkdirSync(OUT, { recursive: true });
const index: string[] = ['# Tutorial articles — Managed Agents in production', ''];
index.push(
  'Each article walks one real-world deployment end to end, with the **actual**',
  'input prompt, the agent’s real message-by-message execution, and the verified',
  'output — captured from live runs on BytePlus. Source captures:',
  '[`scenarios/results/`](../../scenarios/results/).',
  '',
);

for (const [id, art] of Object.entries(ARTICLES)) {
  const s = SCENARIOS[id];
  const result = JSON.parse(fs.readFileSync(join(RESULTS, `${id}.json`), 'utf8'));
  const tPath = join(RESULTS, 'transcripts', `${id}.json`);
  const transcript: Msg[] = fs.existsSync(tPath) ? JSON.parse(fs.readFileSync(tPath, 'utf8')) : [];

  const md: string[] = [];
  md.push(`# ${s.title}`, '', `*${art.subtitle}*`, '');
  md.push(
    `> **Result:** ${result.status} in ${(result.durationMs / 1000).toFixed(0)}s · ` +
      `${result.tokenUsage.calls} model calls · ` +
      `${result.externalActions.length} governed external action(s) · ` +
      `model: Dola-Seed-2.0-lite`,
    '',
  );

  md.push('## The problem', '', art.problem, '');
  md.push('## Why this needs a durable agent runtime', '', art.whyPlatform, '');

  md.push('## The setup (what you give the runtime)', '');
  md.push('**System prompt (agent instructions):**', '```', s.instructions, '```', '');
  md.push('**Goal (the task message):**', '```', result.goal, '```', '');
  if (Object.keys(s.seedFiles ?? {}).length) {
    md.push('**Seed files placed in the durable workspace:**', '');
    for (const [name, content] of Object.entries(s.seedFiles!)) {
      md.push(`\`${name}\``, '```', content.trim(), '```', '');
    }
  }
  if ((s.grants ?? []).length) {
    md.push('**Capability grants:**', '');
    for (const g of s.grants!) {
      md.push(
        `- \`${g.action}\`${g.requiresApproval ? ' — **requires human approval**' : ''}`,
      );
    }
    md.push('');
  }

  if (transcript.length) {
    md.push('## The agent’s execution (real messages)', '');
    md.push(
      'This is the actual sequence the agent ran — its tool calls and the results it saw, ' +
        'recovered from the run transcript persisted to TOS.',
      '',
    );
    md.push(renderConversation(transcript));
  }

  if (result.externalActions.length) {
    md.push('## The governed side effect', '');
    md.push(
      'The external write was held for human approval, then executed **exactly once** ' +
        '(note `receivedCount: 1`) and recorded in the durable receipt ledger:',
      '',
      '```json',
      JSON.stringify(result.externalActions, null, 2),
      '```',
      '',
    );
    if (result.toolReceipts.length) {
      md.push('Receipt:', '');
      md.push('| action | status | reversibility |', '| --- | --- | --- |');
      for (const t of result.toolReceipts) {
        md.push(`| ${t.semantic_action} | ${t.status} | ${t.reversibility} |`);
      }
      md.push('');
    }
  }

  if (Object.keys(result.artifacts).length) {
    md.push('## The verified output', '');
    for (const [name, content] of Object.entries(result.artifacts as Record<string, string>)) {
      md.push(`**\`${name}\`:**`, '```', content.slice(0, 1600), '```', '');
    }
  }

  md.push('## Takeaway', '', art.takeaway, '');
  md.push(
    '---',
    '',
    `*Reproduce: \`node --env-file=.env --import tsx scenarios/run.ts ${id}\`. ` +
      `Full event timeline: [\`scenarios/results/${id}.md\`](../../scenarios/results/${id}.md).*`,
  );

  fs.writeFileSync(join(OUT, `${id}.md`), md.join('\n'));
  index.push(`- **[${s.title}](./${id}.md)** — ${art.subtitle}`);
  console.log(`wrote docs/articles/${id}.md`);
}

index.push(
  '',
  '## How these were produced',
  '',
  'Every article is generated from a live run by ' +
    '[`scenarios/make-articles.ts`](../../scenarios/make-articles.ts): the input comes from the ' +
    'scenario definition, the message exchange from the TOS-persisted transcript, and the output ' +
    'from the captured result. Nothing is hand-edited into the transcripts — the agent messages ' +
    'are exactly what ran.',
);
fs.writeFileSync(join(OUT, 'README.md'), index.join('\n'));
console.log('wrote docs/articles/README.md');
