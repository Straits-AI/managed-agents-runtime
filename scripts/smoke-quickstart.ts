import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = join(import.meta.dirname, '..');
const composeFile = join(root, 'examples', 'quickstart', 'compose.yaml');
const project = `mar-quickstart-${process.pid}-${Date.now()}`;
const runtimeImage = process.env.RUNTIME_IMAGE?.trim()
  || 'ghcr.io/straits-ai/managed-agents-runtime@sha256:07dcb446d811fa51fb30a7746f55ed72becbbb8b5ad41dfafc6ec8cff9af2440';
const env = { ...process.env, RUNTIME_IMAGE: runtimeImage };

async function compose(args: string[], allowFailure = false): Promise<string> {
  try {
    const result = await exec(
      'docker',
      ['compose', '--ansi', 'never', '--project-name', project, '--file', composeFile, ...args],
      { env, maxBuffer: 20 * 1024 * 1024 },
    );
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    if (allowFailure) return '';
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `docker compose ${args.join(' ')} failed\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      { cause: error },
    );
  }
}

try {
  await compose(['config', '--quiet']);
  await compose(['up', '--detach', '--wait', 'postgres', 'api', 'worker']);
  const output = await compose(['run', '--rm', 'first-run']);
  if (!output.includes('PASS first durable run')) {
    throw new Error(`quickstart client did not report success\n${output}`);
  }
  const suspended = await compose([
    'run', '--rm', '-e', 'QUICKSTART_MODE=approval-create', 'first-run',
  ]);
  const encodedState = suspended.match(/QUICKSTART_STATE=([A-Za-z0-9_-]+)/)?.[1];
  if (!encodedState || !suspended.includes('PASS approval suspended')) {
    throw new Error(`approval setup did not report durable suspension\n${suspended}`);
  }
  const state = JSON.parse(Buffer.from(encodedState, 'base64url').toString('utf8')) as {
    runId: string;
    approvalId: string;
  };

  await compose(['stop', 'worker']);
  await compose(['start', 'worker']);
  const resumed = await compose([
    'run', '--rm',
    '-e', 'QUICKSTART_MODE=approval-resume',
    '-e', `RUN_ID=${state.runId}`,
    '-e', `APPROVAL_ID=${state.approvalId}`,
    'first-run',
  ]);
  if (!resumed.includes('PASS approval recovery')) {
    throw new Error(`approval recovery did not complete\n${resumed}`);
  }

  process.stdout.write(`${output}\n${suspended}\n${resumed}\nPASS documented quickstart\n`);
} finally {
  await compose(['down', '--volumes', '--remove-orphans'], true);
}
