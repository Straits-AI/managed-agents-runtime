import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import { newId } from '../ids.js';

type Q = Pool | Tx;

export type ArtifactReference = Record<string, unknown>;

export interface ArtifactRow {
  id: string;
  schema_version: number;
  producer_run_id: string;
  producer_attempt_id: string;
  producer_step: number;
  digest: string;
  mime_type: string;
  size_bytes: string;
  logical_role: string;
  source_path: string;
  source_refs: ArtifactReference[];
  verification_refs: ArtifactReference[];
  evidence_refs: ArtifactReference[];
  object_key: string;
  created_at: Date;
}

export interface CreateArtifactInput {
  id?: string;
  producerRunId: string;
  producerAttemptId: string;
  producerStep: number;
  digest: string;
  mimeType: string;
  sizeBytes: number;
  logicalRole: string;
  sourcePath: string;
  sourceRefs: ArtifactReference[];
  verificationRefs: ArtifactReference[];
  evidenceRefs: ArtifactReference[];
  objectKey: string;
}

export async function createArtifact(
  tx: Tx,
  input: CreateArtifactInput,
): Promise<ArtifactRow> {
  validateArtifactInput(input);
  const { rows } = await tx.query<ArtifactRow>(
    `INSERT INTO artifacts
       (id, schema_version, producer_run_id, producer_attempt_id, producer_step, digest,
        mime_type, size_bytes, logical_role, source_path, source_refs,
        verification_refs, evidence_refs, object_key)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.id ?? newId('art'),
      input.producerRunId,
      input.producerAttemptId,
      input.producerStep,
      input.digest,
      input.mimeType,
      input.sizeBytes,
      input.logicalRole,
      input.sourcePath,
      JSON.stringify(input.sourceRefs),
      JSON.stringify(input.verificationRefs),
      JSON.stringify(input.evidenceRefs),
      input.objectKey,
    ],
  );
  return rows[0]!;
}

export async function listArtifactsForRun(
  q: Q,
  runId: string,
  tenantId?: string,
): Promise<ArtifactRow[]> {
  const { rows } = await q.query<ArtifactRow>(
    `SELECT a.*
       FROM artifacts a
       JOIN runs r ON r.id = a.producer_run_id
      WHERE a.producer_run_id = $1
        AND ($2::text IS NULL OR r.tenant_id = $2)
      ORDER BY a.created_at, a.id`,
    [runId, tenantId ?? null],
  );
  return rows;
}

export async function getArtifactForTenant(
  q: Q,
  artifactId: string,
  tenantId: string,
): Promise<ArtifactRow | null> {
  const { rows } = await q.query<ArtifactRow>(
    `SELECT a.*
       FROM artifacts a
       JOIN runs r ON r.id = a.producer_run_id
      WHERE a.id = $1 AND r.tenant_id = $2`,
    [artifactId, tenantId],
  );
  return rows[0] ?? null;
}

function validateArtifactInput(input: CreateArtifactInput): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.digest)) {
    throw new Error('artifact digest must be a sha256 content digest');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('artifact size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.producerStep) || input.producerStep < 0) {
    throw new Error('artifact producer step must be a non-negative integer');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(input.mimeType)) {
    throw new Error('artifact MIME type is invalid');
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.logicalRole)) {
    throw new Error('artifact logical role is invalid');
  }
  if (input.sourcePath.startsWith('/')
    || input.sourcePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('artifact source path must be normalized and workspace-relative');
  }
  if (!input.objectKey || input.objectKey.startsWith('/') || input.objectKey.includes('..')) {
    throw new Error('artifact object key is invalid');
  }
  for (const references of [input.sourceRefs, input.verificationRefs, input.evidenceRefs]) {
    if (!Array.isArray(references)) throw new Error('artifact references must be arrays');
  }
}
