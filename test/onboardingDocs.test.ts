import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('public controlled-alpha onboarding contract', () => {
  it('ships every file needed for a Docker-only first durable run', () => {
    const required = [
      'examples/quickstart/compose.yaml',
      'examples/quickstart/runtime.env.example',
      'examples/quickstart/quickstart-client.mjs',
      'docs/tutorials/README.md',
      'docs/tutorials/01-first-durable-run.md',
      'docs/tutorials/02-approval-and-recovery.md',
      'docs/tutorials/03-kertas-integration.md',
    ];

    expect(required.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });

  it('pins the public image and keeps the demo API on host loopback', () => {
    const compose = source('examples/quickstart/compose.yaml');
    const digest =
      'ghcr.io/straits-ai/managed-agents-runtime@sha256:07dcb446d811fa51fb30a7746f55ed72becbbb8b5ad41dfafc6ec8cff9af2440';

    expect(compose).toContain(digest);
    expect(compose).toContain('platform: linux/amd64');
    expect(compose).toContain('127.0.0.1:8080:8080');
    expect(compose).toContain('object-store-init:');
    expect(compose).toContain('chown -R 1000:1000 /state');
    expect(compose).not.toMatch(/managed-agents-runtime:(?:latest|main)\b/);
  });

  it('makes first-run success observable through the public API', () => {
    const client = source('examples/quickstart/quickstart-client.mjs');

    expect(client).toContain("'/v1/agents'");
    expect(client).toContain("'/v1/runs'");
    expect(client).toContain("status !== 'COMPLETED'");
    expect(client).toContain('PASS first durable run');
  });

  it('routes readers to operational tutorials without moving Kertas product concerns here', () => {
    const readme = source('README.md');
    const tutorials = source('docs/tutorials/README.md');

    expect(readme).toContain('[Tutorials](./docs/tutorials/README.md)');
    expect(readme).toContain('linux/amd64');
    expect(readme).toContain('Kertas owns Projects');
    expect(tutorials).toContain('Use-case showcases');
    expect(tutorials).toContain('Kertas integration');
  });

  it('executes the documented Compose path against the release candidate in CI', () => {
    const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
    const smoke = source('scripts/smoke-quickstart.ts');
    const workflow = source('.github/workflows/controlled-alpha-gate.yml');

    expect(pkg.scripts['quickstart:smoke']).toBe('tsx scripts/smoke-quickstart.ts');
    expect(smoke).toContain("'compose'");
    expect(smoke).toContain("'down', '--volumes', '--remove-orphans'");
    expect(smoke).toContain('PASS first durable run');
    expect(workflow).toContain('RUNTIME_IMAGE="${CONTAINER_IMAGE}" npm run quickstart:smoke');
  });

  it('exercises approval suspension across a worker restart', () => {
    const client = source('examples/quickstart/quickstart-client.mjs');
    const smoke = source('scripts/smoke-quickstart.ts');
    const tutorial = source('docs/tutorials/02-approval-and-recovery.md');

    expect(client).toContain('approval-create');
    expect(client).toContain('approval-resume');
    expect(client).toContain('/approvals');
    expect(client).toContain('PASS approval recovery');
    expect(smoke).toContain("['stop', 'worker']");
    expect(smoke).toContain("['start', 'worker']");
    expect(tutorial).toContain('suspended_for_approval');
    expect(tutorial).toContain('ToolInvocationCommitted');
  });

  it('documents Kertas integration only through discoverable public contracts', () => {
    const tutorial = source('docs/tutorials/03-kertas-integration.md');

    expect(tutorial).toContain('GET /v1/contracts');
    expect(tutorial).toContain('POST /v1alpha1/sessions');
    expect(tutorial).toContain('POST /v1alpha1/sessions/:id/events');
    expect(tutorial).toContain('GET /v1/runs/:id/events/stream');
    expect(tutorial).toContain('Never import the runtime database');
  });

  it('publishes a repository-wide internal documentation link check', () => {
    const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
    const checker = source('scripts/check-doc-links.ts');
    const workflow = source('.github/workflows/controlled-alpha-gate.yml');

    expect(pkg.scripts['docs:check']).toBe('tsx scripts/check-doc-links.ts');
    expect(checker).toContain("'README.md'");
    expect(checker).toContain("'docs'");
    expect(checker).toContain("'examples'");
    expect(checker).toContain('PASS internal documentation links');
    expect(workflow).toContain('npm run docs:check');
  });
});
