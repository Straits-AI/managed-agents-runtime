import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBoundedProviderFailure,
  runModelArkConformance,
} from '../src/providers/modelArkConformance.js';
import { resolveTosConformanceSource } from '../src/providers/tosConformance.js';

const option = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

const profile = option('--profile', 'dev');
const region = option('--region', 'ap-southeast-1');
const model = option('--model', 'seed-2-0-lite-260228');
const resourceType = option('--resource-type', 'model');
const evidenceFile = option('--evidence-file');
const durationSeconds = 900;
const baseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';

const readGit = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const gitCommit = readGit(['rev-parse', 'HEAD']);
const source = resolveTosConformanceSource({
  explicitCommit: process.env.CONFORMANCE_SOURCE_COMMIT?.trim(),
  gitCommit,
  gitStatus: gitCommit === null ? null : readGit(['status', '--porcelain']),
});

const evidence = await runModelArkConformance({
  async getTemporaryKey() {
    const body = JSON.stringify({
      DurationSeconds: durationSeconds,
      ResourceType: resourceType,
      ResourceIds: [model],
    });
    let stdout: string;
    try {
      stdout = execFileSync('bp', [
        'ark', 'GetApiKey',
        '---profile', profile,
        '---region', region,
        '--body', body,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failure = parseBoundedProviderFailure(
        typeof error === 'object' && error !== null && 'stderr' in error
          ? error.stderr
          : null,
      );
      throw Object.assign(new Error('temporary key request failed'), {
        status: failure.status,
        code: failure.code ?? 'TemporaryKeyRequestFailed',
        requestId: failure.requestId,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw Object.assign(new Error('temporary key response was not JSON'), {
        code: 'TemporaryKeyResponseInvalid',
      });
    }
    const envelope = parsed as {
      ResponseMetadata?: { RequestId?: unknown; Error?: { Code?: unknown } };
      Result?: { ApiKey?: unknown };
    };
    const apiKey = envelope.Result?.ApiKey;
    if (typeof apiKey !== 'string' || !apiKey) {
      throw Object.assign(new Error('temporary key response contained no key'), {
        code: typeof envelope.ResponseMetadata?.Error?.Code === 'string'
          ? envelope.ResponseMetadata.Error.Code
          : 'TemporaryKeyMissing',
        requestId: envelope.ResponseMetadata?.RequestId,
      });
    }
    return {
      apiKey,
      requestId: typeof envelope.ResponseMetadata?.RequestId === 'string'
        ? envelope.ResponseMetadata.RequestId
        : null,
      expiresAt: new Date(Date.now() + durationSeconds * 1_000),
    };
  },
  async invoke({ apiKey, model: selectedModel }) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: 'Reply with exactly PONG' }],
        max_tokens: 32,
        temperature: 0,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const requestId = response.headers.get('x-request-id');
    const bytes = await readBoundedBody(response, 64 * 1024, requestId);
    let payload: {
      id?: unknown;
      error?: { code?: unknown };
      choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw Object.assign(new Error('response was not JSON'), {
        status: response.status,
        code: 'InvalidJson',
        requestId,
      });
    }
    if (!response.ok) {
      throw Object.assign(new Error('inference failed'), {
        status: response.status,
        code: typeof payload.error?.code === 'string' ? payload.error.code : 'InferenceFailed',
        requestId,
      });
    }
    const choice = payload.choices?.[0];
    const output = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    return {
      markerMatched: /^\s*pong\s*$/i.test(output),
      requestId: requestId ?? (typeof payload.id === 'string' ? payload.id : null),
      inputTokens: typeof payload.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : 0,
      outputTokens: typeof payload.usage?.completion_tokens === 'number' ? payload.usage.completion_tokens : 0,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown',
      output,
    };
  },
}, { model });

const sourceAfter = readGit(['rev-parse', 'HEAD']);
if (sourceAfter !== source.commit || readGit(['status', '--porcelain'])) {
  throw new Error('ModelArk conformance source revision changed during the live run');
}
const record = {
  schemaVersion: 1,
  evidenceId: `byteplus-modelark-${evidence.inference.requestId ?? Date.now()}`,
  source: {
    repository: 'https://github.com/Straits-AI/managed-agents-runtime',
    commit: source.commit,
    commitOrigin: source.commitOrigin,
  },
  provider: 'byteplus-modelark',
  region,
  retrievedAt: new Date().toISOString(),
  toolchain: { runtime: `node ${process.version}`, api: 'chat-completions', maxOutputTokens: 32 },
  evidence,
};
writeFileSync(resolve(evidenceFile), `${JSON.stringify(record, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  requestId: string | null,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw Object.assign(new Error('response exceeded bound'), {
          status: response.status,
          code: 'ResponseTooLarge',
          requestId,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
