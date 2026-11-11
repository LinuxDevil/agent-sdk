import { assertCheckpointId } from '../../session/checkpointId';
import { assertSessionId } from '../../session/sessionId';
import { listCheckpoints, parseCheckpoint, type Checkpoint, type CheckpointListEntry, type CheckpointListOptions, type CheckpointStore } from '../../execution/checkpoint';
import type { SessionStore } from '../../session/sessionStore';
import type { Message } from '../../providers/llm';
import { decodeBytes, encodeBytes } from '../../storage/jsonBytes';
import type { SqlRow } from '../../storage/sqlite/driver';
import type { PageRunEvent } from '../contracts/execution';
import { isUniqueViolation, type SqlClient } from './sql';
import type { RunLedger, RunRecord, RunState, WorkspaceScope } from './stores';
import { SDKError } from '../../execution/errors';

const APPEND_ATTEMPTS = 5;

const UPSERT_THREAD =
  'INSERT INTO ws_threads (key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at';
const UPSERT_CHECKPOINT =
  'INSERT INTO ws_checkpoints (key, payload, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, status = excluded.status, updated_at = excluded.updated_at';

function toRecord(row: SqlRow): RunRecord {
  const record: RunRecord = {
    runId: String(row.run_id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id),
    pageId: String(row.page_id),
    revision: String(row.revision),
    status: String(row.status) as RunState,
    startedAt: Number(row.started_at),
  };
  if (row.ended_at !== null && row.ended_at !== undefined) record.endedAt = Number(row.ended_at);
  return record;
}

/** A {@link RunLedger} over a {@link SqlClient}: run rows in `ws_runs`, events in `ws_run_events` with a per-run sequence. */
export function sqlRunLedger(client: SqlClient): RunLedger {
  return {
    async insertRun(record) {
      try {
        await client.execute(
          'INSERT INTO ws_runs (run_id, project_id, workspace_id, page_id, revision, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [record.runId, record.projectId, record.workspaceId, record.pageId, record.revision, record.status, record.startedAt, record.endedAt ?? null]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new SDKError(`Run ${record.runId} already exists.`, 'LOUSHO_CONFIG_INVALID', { cause: error });
        throw error;
      }
    },
    async updateRun(runId, status, endedAt) {
      await client.execute('UPDATE ws_runs SET status = ?, ended_at = ? WHERE run_id = ?', [status, endedAt ?? null, runId]);
    },
    async getRun(runId) {
      const rows = await client.query('SELECT * FROM ws_runs WHERE run_id = ?', [runId]);
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async listRuns(scope: WorkspaceScope, states) {
      const filter = states ? ` AND status IN (${states.map(() => '?').join(', ')})` : '';
      if (states?.length === 0) return [];
      const rows = await client.query(`SELECT * FROM ws_runs WHERE project_id = ? AND workspace_id = ?${filter} ORDER BY started_at, run_id`, [
        scope.projectId,
        scope.workspaceId,
        ...(states ?? []),
      ]);
      return rows.map(toRecord);
    },
    async appendEvent(runId, event) {
      const payload = JSON.stringify(event);
      for (let attempt = 1; ; attempt++) {
        try {
          const rows = await client.query(
            'INSERT INTO ws_run_events (run_id, seq, event) SELECT CAST(? AS TEXT), COALESCE(MAX(seq) + 1, 0), CAST(? AS TEXT) FROM ws_run_events WHERE run_id = ? RETURNING seq',
            [runId, payload, runId]
          );
          return Number(rows[0]?.seq);
        } catch (error) {
          if (!isUniqueViolation(error) || attempt >= APPEND_ATTEMPTS) throw error;
        }
      }
    },
    async readEvents(runId, afterId) {
      const rows = await client.query('SELECT seq, event FROM ws_run_events WHERE run_id = ? AND seq > ? ORDER BY seq', [runId, afterId ?? -1]);
      return rows.map((row) => ({ id: Number(row.seq), event: JSON.parse(String(row.event)) as PageRunEvent }));
    },
  };
}

/** A {@link SessionStore} over `ws_threads`, for hosts on Postgres. */
export function sqlSessionStore(client: SqlClient): SessionStore {
  return {
    async load(id) {
      assertSessionId(id);
      const rows = await client.query('SELECT payload FROM ws_threads WHERE key = ?', [id]);
      return rows[0] ? (JSON.parse(String(rows[0].payload), decodeBytes) as Message[]) : undefined;
    },
    async save(id, messages) {
      assertSessionId(id);
      await client.execute(UPSERT_THREAD, [id, JSON.stringify(messages, encodeBytes), Date.now()]);
    },
    async delete(id) {
      assertSessionId(id);
      await client.execute('DELETE FROM ws_threads WHERE key = ?', [id]);
    },
  };
}

/** A {@link CheckpointStore} over `ws_checkpoints` (latest checkpoint per id, no history or leases: one instance runs the host). */
export function sqlCheckpointStore(client: SqlClient): CheckpointStore {
  const read = (row: SqlRow): Checkpoint => parseCheckpoint(String(row.payload), String(row.key), 'the ws_checkpoints table', decodeBytes);
  return {
    async save(id, checkpoint: Checkpoint) {
      assertCheckpointId(id);
      await client.execute(UPSERT_CHECKPOINT, [id, JSON.stringify(checkpoint, encodeBytes), checkpoint.status ?? 'in-progress', Date.now()]);
    },
    async load(id) {
      assertCheckpointId(id);
      const rows = await client.query('SELECT key, payload FROM ws_checkpoints WHERE key = ?', [id]);
      return rows[0] ? read(rows[0]) : null;
    },
    async delete(id) {
      assertCheckpointId(id);
      await client.execute('DELETE FROM ws_checkpoints WHERE key = ?', [id]);
    },
    async list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]> {
      const rows = await client.query('SELECT key, payload FROM ws_checkpoints ORDER BY key');
      return listCheckpoints(
        rows.map((row) => [String(row.key), read(row)] as const),
        options
      );
    },
  };
}
