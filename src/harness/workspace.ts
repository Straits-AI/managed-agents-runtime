import type { Pool } from 'pg';
import { withTransaction } from '../db/tx.js';
import { appendEvent } from '../core/transition.js';
import { insertRevision, getRevision, headRevision } from '../store/workspaces.js';
import type { ObjectStore, SandboxHandle, SandboxProvider } from '../providers/types.js';

const WORKSPACE_DIR = '/workspace';

/**
 * Durable workspace management (memo §15): the sandbox filesystem is never
 * authoritative — snapshots live in TOS as immutable tarball revisions,
 * moved via presigned URLs so bytes never transit the control plane.
 */
export class WorkspaceManager {
  constructor(
    private readonly pool: Pool,
    private readonly sandbox: SandboxProvider,
    private readonly store: ObjectStore,
  ) {}

  /**
   * Restore the workspace into a fresh sandbox: head revision tarball if
   * one exists, otherwise seed files from run input.
   */
  async restore(
    handle: SandboxHandle,
    input: {
      runId: string;
      attemptId: string;
      workspaceId: string;
      seedFiles?: Record<string, string>;
      initCommand?: string;
    },
  ): Promise<{ restoredRevisionId: string | null }> {
    await this.sandbox.exec(handle, `mkdir -p ${WORKSPACE_DIR}`);

    const head = await headRevision(this.pool, input.workspaceId);
    if (head) {
      const url = await this.store.presignGet(head.tos_key, 900);
      const res = await this.sandbox.exec(
        handle,
        `curl -fsSL '${url}' | tar -xz -C ${WORKSPACE_DIR}`,
        { timeoutSec: 300 },
      );
      if (res.exitCode !== 0) {
        throw new Error(
          `workspace restore failed (rev ${head.id}): ${res.stderr.slice(0, 300)}`,
        );
      }
    } else {
      for (const [path, content] of Object.entries(input.seedFiles ?? {})) {
        await this.sandbox.writeFile(handle, `${WORKSPACE_DIR}/${path}`, content);
      }
      if (input.initCommand) {
        const res = await this.sandbox.exec(handle, input.initCommand, {
          cwd: WORKSPACE_DIR,
          timeoutSec: 600,
        });
        if (res.exitCode !== 0) {
          throw new Error(`workspace init failed: ${res.stderr.slice(0, 300)}`);
        }
      }
    }

    await withTransaction(this.pool, (tx) =>
      appendEvent(
        tx,
        input.runId,
        {
          type: 'WorkspaceRestored',
          payload: {
            sandboxId: handle.sandboxId,
            fromRevision: head?.id ?? null,
          },
        },
        { attemptId: input.attemptId },
      ),
    );
    return { restoredRevisionId: head?.id ?? null };
  }

  /**
   * Snapshot the workspace to TOS and record an immutable revision.
   */
  async checkpoint(
    handle: SandboxHandle,
    input: { runId: string; attemptId: string; workspaceId: string },
  ): Promise<string> {
    const tosKey = `runs/${input.runId}/workspace/${Date.now()}-${handle.sandboxId}.tgz`;
    const putUrl = await this.store.presignPut(tosKey, 900);

    const res = await this.sandbox.exec(
      handle,
      `cd ${WORKSPACE_DIR} && tar -czf /tmp/ws-snapshot.tgz . && ` +
        `curl -fsS -X PUT --upload-file /tmp/ws-snapshot.tgz '${putUrl}' && ` +
        `sha256sum /tmp/ws-snapshot.tgz | cut -d' ' -f1 && ` +
        `stat -c %s /tmp/ws-snapshot.tgz`,
      { timeoutSec: 300 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`workspace snapshot failed: ${res.stderr.slice(0, 300)}`);
    }
    const lines = res.stdout.trim().split('\n');
    const digest = lines.at(-2) ?? 'unknown';
    const sizeBytes = Number(lines.at(-1) ?? '0');

    const revision = await withTransaction(this.pool, async (tx) => {
      const rev = await insertRevision(tx, {
        workspaceId: input.workspaceId,
        tosKey,
        digest,
        sizeBytes,
        attemptId: input.attemptId,
      });
      await appendEvent(
        tx,
        input.runId,
        {
          type: 'WorkspaceCheckpointed',
          payload: { revisionId: rev.id, tosKey, digest, sizeBytes },
        },
        { attemptId: input.attemptId },
      );
      return rev;
    });
    return revision.id;
  }

  async revisionDownloadUrl(revisionId: string, ttlSec = 3600): Promise<string | null> {
    const rev = await getRevision(this.pool, revisionId);
    return rev ? this.store.presignGet(rev.tos_key, ttlSec) : null;
  }
}

export { WORKSPACE_DIR };
