import { describe, it, expect } from 'vitest';
import { RegistrySkillProvider } from '../src/providers/registrySkills.js';
import { materializeSkills } from '../src/harness/skills.js';
import { compileContext } from '../src/harness/contextCompiler.js';
import type { SandboxHandle, SandboxProvider } from '../src/providers/types.js';
import type { AgentVersionRow } from '../src/store/agents.js';
import type { RunRow } from '../src/core/types.js';

function fakeVersion(): AgentVersionRow {
  return {
    id: 'av1', agent_id: 'a1', version: 1, instructions: 'do work',
    model_policy: {}, tool_policy: {}, skill_refs: [], mcp_toolset_refs: [],
    sandbox_spec: {}, context_strategy: {}, verifier_policy: {}, knowledge_config: {},
    created_at: new Date(),
  };
}
function fakeRun(): RunRow {
  return {
    id: 'r1', tenant_id: 'default', agent_version_id: 'av1', parent_run_id: null,
    replaces_run_id: null, replacement_generation: 0,
    goal: 'g', input: {}, status: 'RUNNING', status_reason: null, progress: {},
    workspace_id: 'w1', current_attempt_id: null, last_event_seq: '0', max_steps: 50,
    token_budget: null, tokens_used: '0', awaited_signal: null, scheduled_for: null,
    debug_fault_points: [], created_at: new Date(), updated_at: new Date(),
  };
}

describe('skills', () => {
  const registry = new RegistrySkillProvider().register('1.2.0', {
    name: 'code-review',
    version: '1.2.0',
    description: 'How to review a pull request',
    files: {
      'SKILL.md': '# Code review\nCheck for bugs, tests, and style.',
      'checklist.txt': '1. correctness\n2. tests\n3. security',
    },
  });

  it('resolves only exact pinned versions', async () => {
    await expect(
      registry.resolve({ provider: 'registry', skill: 'code-review', version: 'latest' }),
    ).rejects.toThrow(/pinned to an exact version/);
    await expect(
      registry.resolve({ provider: 'registry', skill: 'code-review', version: '9.9.9' }),
    ).rejects.toThrow(/not found/);
    const ok = await registry.resolve({ provider: 'registry', skill: 'code-review', version: '1.2.0' });
    expect(ok.files['SKILL.md']).toContain('Code review');
  });

  it('materializes skill files into the workspace under .skills/', async () => {
    const written: Record<string, string> = {};
    const sandbox: SandboxProvider = {
      async writeFile(_h: SandboxHandle, path: string, content: string) {
        written[path] = content;
      },
    } as unknown as SandboxProvider;

    const materialized = await materializeSkills(
      {} as SandboxHandle,
      sandbox,
      registry,
      [{ provider: 'registry', skill: 'code-review', version: '1.2.0' }],
    );
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({ name: 'code-review', version: '1.2.0' });
    expect(written['/home/gem/workspace/.skills/code-review/SKILL.md']).toContain('Code review');
    expect(written['/home/gem/workspace/.skills/code-review/checklist.txt']).toContain('security');
  });

  it('surfaces available skills in the compiled context', () => {
    const messages = compileContext({
      version: fakeVersion(), run: fakeRun(), grants: [], transcript: [],
      userMessages: [], approvalOutcomes: [], toolDocs: '',
      skills: [{ name: 'code-review', version: '1.2.0', description: 'review PRs', path: '/home/gem/workspace/.skills/code-review' }],
    });
    const system = messages.find((m) => m.role === 'system')!.content as string;
    expect(system).toContain('Skills available');
    expect(system).toContain('code-review v1.2.0');
  });
});
