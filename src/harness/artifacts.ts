import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { ObjectStore, SandboxHandle, SandboxProvider } from '../providers/types.js';
import type { CreateArtifactInput } from '../store/artifacts.js';
import { WORKSPACE_DIR } from './workspace.js';

export interface StageArtifactContext {
  runId: string;
  attemptId: string;
  producerStep: number;
  verificationPassedEventSeq: string;
  sandbox: SandboxHandle;
  sandboxProvider: SandboxProvider;
  objectStore: ObjectStore;
}

/**
 * Copy verified workspace outputs into private durable storage and build the
 * immutable rows that will be committed atomically with RunCompleted.
 *
 * IDs and object keys are deterministic for a run/path/content tuple. If a
 * worker dies after upload but before the database transaction, recovery
 * overwrites the same private object instead of publishing a duplicate.
 */
export async function stageArtifactOutputs(
  ctx: StageArtifactContext,
  claimedPaths: string[],
): Promise<CreateArtifactInput[]> {
  const sourcePaths = [...new Set(claimedPaths.map(normalizeArtifactPath))];
  const staged: CreateArtifactInput[] = [];

  for (const sourcePath of sourcePaths) {
    const bytes = Buffer.from(await ctx.sandboxProvider.readFile(
      ctx.sandbox,
      `${WORKSPACE_DIR}/${sourcePath}`,
    ));
    const digestHex = createHash('sha256').update(bytes).digest('hex');
    const id = deterministicArtifactId(ctx.runId, sourcePath, digestHex);
    const objectKey = `runs/${ctx.runId}/artifacts/${id}`;
    await ctx.objectStore.put(objectKey, bytes);
    staged.push({
      id,
      producerRunId: ctx.runId,
      producerAttemptId: ctx.attemptId,
      producerStep: ctx.producerStep,
      digest: `sha256:${digestHex}`,
      mimeType: mimeTypeFor(sourcePath),
      sizeBytes: bytes.byteLength,
      logicalRole: 'deliverable',
      sourcePath,
      sourceRefs: [{ kind: 'workspace_path', path: sourcePath }],
      verificationRefs: [{
        kind: 'runtime_verifier',
        status: 'passed',
        runId: ctx.runId,
        eventSeq: ctx.verificationPassedEventSeq,
      }],
      evidenceRefs: [{
        kind: 'run_event',
        runId: ctx.runId,
        seq: ctx.verificationPassedEventSeq,
        type: 'VerificationPassed',
      }],
      objectKey,
    });
  }
  return staged;
}

export function normalizeArtifactPath(path: string): string {
  const candidate = path.startsWith(`${WORKSPACE_DIR}/`)
    ? path.slice(WORKSPACE_DIR.length + 1)
    : path;
  if (!candidate
    || candidate.startsWith('/')
    || candidate.includes('\\')
    || candidate.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`artifact path must be normalized and workspace-relative: ${path}`);
  }
  return candidate;
}

function deterministicArtifactId(runId: string, sourcePath: string, digestHex: string): string {
  const suffix = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(sourcePath)
    .update('\0')
    .update(digestHex)
    .digest('hex')
    .slice(0, 32);
  return `art_${suffix}`;
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.csv': return 'text/csv';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.html': return 'text/html';
    case '.json': return 'application/json';
    case '.md': return 'text/markdown';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}
