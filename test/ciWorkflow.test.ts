import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const workflowsDir = join(root, '.github', 'workflows');
const workflowSources = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => readFileSync(join(workflowsDir, file), 'utf8'));
const provenance = readFileSync(
  join(root, 'docs', 'CONTROLLED-ALPHA-RELEASE-GATE.md'),
  'utf8',
);

const reviewedActions = [
  {
    repository: 'actions/checkout',
    tag: 'v7.0.0',
    sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  },
  {
    repository: 'actions/setup-node',
    tag: 'v7.0.0',
    sha: '820762786026740c76f36085b0efc47a31fe5020',
  },
  {
    repository: 'actions/upload-artifact',
    tag: 'v7.0.1',
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  },
] as const;

describe('controlled-alpha GitHub Actions supply chain', () => {
  it('uses only the reviewed Node 24-native actions at immutable SHAs', () => {
    const references = workflowSources.flatMap((workflow) => [
      ...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm),
    ].map(([, reference]) => reference!));

    expect([...new Set(references)].sort()).toEqual(
      reviewedActions.map(({ repository, sha }) => `${repository}@${sha}`).sort(),
    );

    for (const { repository, tag, sha } of reviewedActions) {
      expect(provenance).toContain(
        `| [\`${repository}\`](https://github.com/${repository}/releases/tag/${tag}) | \`${tag}\` | \`${sha}\` | \`node24\` |`,
      );
    }
  });
});
