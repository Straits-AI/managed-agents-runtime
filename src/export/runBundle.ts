import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { ObjectStore } from '../providers/types.js';
import { listArtifactsForRun, type ArtifactRow } from '../store/artifacts.js';

/**
 * A portable, provider-neutral snapshot of a run's authoritative state (memo
 * §20/§21): the run, its gapless event history, attempts, receipts, approvals,
 * grants, and the workspace (revision metadata + the latest snapshot tarball
 * inlined as base64). Everything a customer needs to audit, replay, or move the
 * run to another deployment — the execution state is owned by us, not the
 * cloud provider.
 */
export interface RunBundle {
  bundleVersion: 2;
  exportedAtSeq: string; // the run's last_event_seq at export
  run: Record<string, unknown>;
  attempts: Record<string, unknown>[];
  events: { seq: string; type: string; payload: unknown; created_at: string }[];
  receipts: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  grants: Record<string, unknown>[];
  artifacts: ArtifactBundleRecord[];
  workspace: {
    revisions: Record<string, unknown>[];
    latestSnapshotBase64: string | null;
    latestSnapshotKey: string | null;
  };
}

export interface ArtifactBundleRecord {
  id: string;
  schemaVersion: 1;
  digest: string;
  mimeType: string;
  sizeBytes: string;
  logicalRole: string;
  sourcePath: string;
  producer: {
    runId: string;
    attemptId: string;
    step: number;
  };
  sourceRefs: Record<string, unknown>[];
  verificationRefs: Record<string, unknown>[];
  evidenceRefs: Record<string, unknown>[];
  contentBase64: string;
  createdAt: string;
}

export async function exportRunBundle(
  pool: Pool,
  store: ObjectStore,
  runId: string,
  /**
   * Tenant the caller is authorized for. When provided, a run belonging to a
   * different tenant is reported as not-found (never leak its existence or
   * contents). REQUIRED once the API carries a per-tenant identity — an export
   * is a bulk dump of a run's entire state, so it must be tenant-scoped.
   */
  expectedTenantId?: string,
): Promise<RunBundle> {
  const one = async (sql: string) => (await pool.query(sql, [runId])).rows;
  const run = (await pool.query('SELECT * FROM runs WHERE id = $1', [runId])).rows[0];
  if (!run || (expectedTenantId !== undefined && run.tenant_id !== expectedTenantId)) {
    throw new Error(`run not found: ${runId}`);
  }

  const events = (
    await pool.query(
      'SELECT seq, type, payload, created_at FROM run_events WHERE run_id = $1 ORDER BY seq',
      [runId],
    )
  ).rows;

  // Verify the exported history is gapless before we hand it off.
  events.forEach((e, i) => {
    if (Number(e.seq) !== i + 1) {
      throw new Error(`event history has a gap at position ${i} (seq ${e.seq}); refusing to export`);
    }
  });

  const revisions = run.workspace_id
    ? (await pool.query(
        'SELECT * FROM workspace_revisions WHERE workspace_id = $1 ORDER BY created_at',
        [run.workspace_id],
      )).rows
    : [];
  const latest = revisions[revisions.length - 1];
  let latestSnapshotBase64: string | null = null;
  if (latest?.tos_key) {
    latestSnapshotBase64 = (await store.get(latest.tos_key as string)).toString('base64');
  }

  const artifactRows = await listArtifactsForRun(pool, runId, run.tenant_id as string);
  const artifacts = await Promise.all(
    artifactRows.map(async (artifact) => artifactToBundleRecord(
      artifact,
      await store.get(artifact.object_key),
    )),
  );

  return {
    bundleVersion: 2,
    exportedAtSeq: String(run.last_event_seq),
    run,
    attempts: await one('SELECT * FROM run_attempts WHERE run_id = $1 ORDER BY attempt_no'),
    events,
    receipts: await one('SELECT * FROM tool_receipts WHERE run_id = $1 ORDER BY started_at'),
    approvals: await one('SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_at'),
    grants: await one('SELECT * FROM capability_grants WHERE run_id = $1 ORDER BY created_at'),
    artifacts,
    workspace: {
      revisions,
      latestSnapshotBase64,
      latestSnapshotKey: (latest?.tos_key as string) ?? null,
    },
  };
}

function artifactToBundleRecord(artifact: ArtifactRow, bytes: Buffer): ArtifactBundleRecord {
  const digest = sha256Digest(bytes);
  if (digest !== artifact.digest) {
    throw new Error(`artifact digest mismatch during export: ${artifact.id}`);
  }
  if (String(bytes.byteLength) !== String(artifact.size_bytes)) {
    throw new Error(`artifact size mismatch during export: ${artifact.id}`);
  }
  return {
    id: artifact.id,
    schemaVersion: 1,
    digest: artifact.digest,
    mimeType: artifact.mime_type,
    sizeBytes: String(artifact.size_bytes),
    logicalRole: artifact.logical_role,
    sourcePath: artifact.source_path,
    producer: {
      runId: artifact.producer_run_id,
      attemptId: artifact.producer_attempt_id,
      step: artifact.producer_step,
    },
    sourceRefs: artifact.source_refs,
    verificationRefs: artifact.verification_refs,
    evidenceRefs: artifact.evidence_refs,
    contentBase64: bytes.toString('base64'),
    createdAt: artifact.created_at.toISOString(),
  };
}

/**
 * Validate artifact bytes and lineage before an importer is allowed to persist
 * a bundle. This intentionally knows nothing about provider object keys: an
 * importer allocates new private locators only after this check passes.
 */
export function validateRunBundleForImport(bundle: RunBundle): void {
  if (bundle.bundleVersion !== 2) throw new Error('unsupported run bundle version');
  const runId = stringField(bundle.run, 'id', 'bundle run ID');
  const attempts = new Set(
    bundle.attempts
      .filter((attempt) => attempt.run_id === runId)
      .map((attempt) => stringField(attempt, 'id', 'bundle attempt ID')),
  );
  const ids = new Set<string>();
  for (const artifact of bundle.artifacts) {
    if (artifact.schemaVersion !== 1) {
      throw new Error(`unsupported artifact schema version: ${artifact.id}`);
    }
    if (ids.has(artifact.id)) throw new Error(`duplicate artifact ID: ${artifact.id}`);
    ids.add(artifact.id);
    if (artifact.producer.runId !== runId
      || !attempts.has(artifact.producer.attemptId)
      || !Number.isSafeInteger(artifact.producer.step)
      || artifact.producer.step < 0) {
      throw new Error(`artifact attempt lineage is invalid: ${artifact.id}`);
    }
    if (!Array.isArray(artifact.sourceRefs)
      || !Array.isArray(artifact.verificationRefs)
      || !Array.isArray(artifact.evidenceRefs)) {
      throw new Error(`artifact references are invalid: ${artifact.id}`);
    }
    if (!artifact.sourcePath
      || artifact.sourcePath.startsWith('/')
      || artifact.sourcePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`artifact source path is invalid: ${artifact.id}`);
    }
    const bytes = decodeBase64(artifact.contentBase64, artifact.id);
    if (sha256Digest(bytes) !== artifact.digest) {
      throw new Error(`artifact digest mismatch during import: ${artifact.id}`);
    }
    if (String(bytes.byteLength) !== artifact.sizeBytes) {
      throw new Error(`artifact size mismatch during import: ${artifact.id}`);
    }
  }
}

function decodeBase64(value: string, artifactId: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`artifact content encoding is invalid: ${artifactId}`);
  }
  return Buffer.from(value, 'base64');
}

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  description: string,
): string {
  const result = value[field];
  if (typeof result !== 'string' || !result) throw new Error(`${description} is invalid`);
  return result;
}
