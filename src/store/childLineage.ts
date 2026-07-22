import type { Pool } from 'pg';
import type { Tx } from '../db/tx.js';
import type { DurableRunResult } from '../core/delegatedResults.js';

type Q = Pool | Tx;

interface ChildRow {
  id: string;
  parent_run_id: string;
  replaces_run_id: string | null;
  replacement_generation: number;
  goal: string;
  status: string;
  status_reason: string | null;
  result: DurableRunResult | null;
  result_size_bytes: number | null;
  tokens_used: string;
  terminal_event_seq: string | null;
  terminal_event_type: string | null;
}

interface ArtifactRefRow {
  id: string;
  producer_run_id: string;
  schema_version: number;
  digest: string;
  mime_type: string;
  size_bytes: string;
  logical_role: string;
}

export interface DelegatedChildResult {
  schemaVersion: 1;
  parentRunId: string;
  rootRunId: string;
  runId: string;
  replacesRunId: string | null;
  replacementGeneration: number;
  selected: boolean;
  goal: string;
  status: string;
  terminalReason: string;
  result: DurableRunResult | null;
  resultSizeBytes: number | null;
  artifactRefs: Array<{
    id: string;
    schemaVersion: number;
    digest: string;
    mimeType: string;
    sizeBytes: string;
    logicalRole: string;
  }>;
  evidenceRefs: Array<{ kind: 'run_event'; runId: string; seq: string; type: string }>;
  usage: { tokens: string };
  workspaceMerge: {
    strategy: 'isolated-no-automatic-merge';
    patchRef: null;
    conflictBehavior: 'parent-must-apply-explicit-patch';
  };
}

export interface ChildLineageProjection {
  schemaVersion: 1;
  parentRunId: string;
  children: DelegatedChildResult[];
  selected: DelegatedChildResult[];
}

/**
 * Queryable child lineage and bounded results. Consumers never need to scan or
 * interpret raw run events; the ledger is represented by stable evidence refs.
 */
export async function childLineageProjection(
  q: Q,
  parentRunId: string,
  tenantId: string,
): Promise<ChildLineageProjection | null> {
  const { rows: parents } = await q.query<{ id: string }>(
    'SELECT id FROM runs WHERE id = $1 AND tenant_id = $2',
    [parentRunId, tenantId],
  );
  if (!parents[0]) return null;

  const { rows } = await q.query<ChildRow>(
    `SELECT c.id, c.parent_run_id, c.replaces_run_id, c.replacement_generation,
            c.goal, c.status, c.status_reason, c.result, c.result_size_bytes,
            c.tokens_used, terminal.seq AS terminal_event_seq,
            terminal.type AS terminal_event_type
       FROM runs c
       LEFT JOIN LATERAL (
         SELECT e.seq, e.type
           FROM run_events e
          WHERE e.run_id = c.id
            AND e.type = ANY($3::text[])
          ORDER BY e.seq DESC
          LIMIT 1
       ) terminal ON true
      WHERE c.parent_run_id = $1 AND c.tenant_id = $2
      ORDER BY c.replacement_generation, c.created_at, c.id`,
    [parentRunId, tenantId, ['RunCompleted', 'RunFailed', 'RunCancelled']],
  );
  const ids = rows.map((row) => row.id);
  const artifactRows = ids.length === 0
    ? []
    : (await q.query<ArtifactRefRow>(
      `SELECT id, producer_run_id, schema_version, digest, mime_type,
              size_bytes, logical_role
         FROM artifacts
        WHERE producer_run_id = ANY($1::text[])
        ORDER BY created_at, id`,
      [ids],
    )).rows;
  const artifactsByRun = new Map<string, ArtifactRefRow[]>();
  for (const artifact of artifactRows) {
    const refs = artifactsByRun.get(artifact.producer_run_id) ?? [];
    refs.push(artifact);
    artifactsByRun.set(artifact.producer_run_id, refs);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const superseded = new Set(rows.flatMap((row) => row.replaces_run_id ? [row.replaces_run_id] : []));
  const rootOf = (row: ChildRow): string => {
    let cursor = row;
    const visited = new Set<string>();
    while (cursor.replaces_run_id) {
      if (visited.has(cursor.id)) throw new Error(`replacement lineage cycle at ${cursor.id}`);
      visited.add(cursor.id);
      const previous = byId.get(cursor.replaces_run_id);
      if (!previous) throw new Error(`replacement lineage predecessor missing: ${cursor.id}`);
      cursor = previous;
    }
    return cursor.id;
  };

  const children = rows.map((row): DelegatedChildResult => ({
    schemaVersion: 1,
    parentRunId,
    rootRunId: rootOf(row),
    runId: row.id,
    replacesRunId: row.replaces_run_id,
    replacementGeneration: row.replacement_generation,
    selected: !superseded.has(row.id),
    goal: row.goal,
    status: row.status,
    terminalReason: row.status_reason ?? row.status.toLowerCase(),
    result: row.result,
    resultSizeBytes: row.result_size_bytes,
    artifactRefs: (artifactsByRun.get(row.id) ?? []).map((artifact) => ({
      id: artifact.id,
      schemaVersion: artifact.schema_version,
      digest: artifact.digest,
      mimeType: artifact.mime_type,
      sizeBytes: artifact.size_bytes,
      logicalRole: artifact.logical_role,
    })),
    evidenceRefs: row.terminal_event_seq && row.terminal_event_type
      ? [{
          kind: 'run_event',
          runId: row.id,
          seq: row.terminal_event_seq,
          type: row.terminal_event_type,
        }]
      : [],
    usage: { tokens: row.tokens_used },
    workspaceMerge: {
      strategy: 'isolated-no-automatic-merge',
      patchRef: null,
      conflictBehavior: 'parent-must-apply-explicit-patch',
    },
  }));
  return {
    schemaVersion: 1,
    parentRunId,
    children,
    selected: children.filter((child) => child.selected),
  };
}
