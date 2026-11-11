import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SDKError } from '../../execution/errors';
import type { PageRunEvent } from '../contracts/execution';
import type { RunLedger, RunRecord, RunState, WorkspaceScope } from './stores';

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function eventLines(text: string | undefined): string[] {
  return text ? text.split('\n').filter((line) => line !== '') : [];
}

function inScope(row: RunRecord | undefined, scope: WorkspaceScope, states: readonly RunState[] | undefined): boolean {
  if (row?.projectId !== scope.projectId || row.workspaceId !== scope.workspaceId) return false;
  return states === undefined || states.includes(row.status);
}

function byStart(a: RunRecord, b: RunRecord): number {
  return a.startedAt - b.startedAt || a.runId.localeCompare(b.runId);
}

/** A {@link RunLedger} of JSON files: `runs/<id>.json` per run and `events/<id>.ndjson` per run, one event per line; the sequence is the line count, so it survives restarts. */
export function fileRunLedger(dir: string): RunLedger {
  const runs = join(resolve(dir), 'runs');
  const events = join(resolve(dir), 'events');
  const tails = new Map<string, Promise<unknown>>();
  const serial = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    const next = (tails.get(runId) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => undefined);
    tails.set(runId, tail);
    void tail.then(() => tails.get(runId) === tail && tails.delete(runId));
    return next;
  };
  const getRun = async (runId: string): Promise<RunRecord | undefined> => {
    const text = await readText(join(runs, `${runId}.json`));
    return text === undefined ? undefined : (JSON.parse(text) as RunRecord);
  };
  return {
    getRun,
    insertRun: (record) =>
      serial(record.runId, async () => {
        if (await getRun(record.runId)) throw new SDKError(`Run ${record.runId} already exists.`, 'LOUSHO_CONFIG_INVALID');
        await mkdir(runs, { recursive: true });
        await writeFile(join(runs, `${record.runId}.json`), JSON.stringify(record));
      }),
    updateRun: (runId, status, endedAt) =>
      serial(runId, async () => {
        const row = await getRun(runId);
        if (!row) throw new SDKError(`Run ${runId} does not exist.`, 'LOUSHO_CONFIG_INVALID');
        const { endedAt: _previous, ...rest } = row;
        await writeFile(join(runs, `${runId}.json`), JSON.stringify(endedAt === undefined ? { ...rest, status } : { ...rest, status, endedAt }));
      }),
    async listRuns(scope, states) {
      let names: string[] = [];
      try {
        names = await readdir(runs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const rows = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => getRun(name.slice(0, -5))));
      return rows.filter((row): row is RunRecord => inScope(row, scope, states)).sort(byStart);
    },
    appendEvent: (runId, event) =>
      serial(runId, async () => {
        await mkdir(events, { recursive: true });
        const path = join(events, `${runId}.ndjson`);
        const seq = eventLines(await readText(path)).length;
        await appendFile(path, `${JSON.stringify(event)}\n`);
        return seq;
      }),
    async readEvents(runId, afterId) {
      const lines = eventLines(await readText(join(events, `${runId}.ndjson`)));
      return lines.map((line, id) => ({ id, event: JSON.parse(line) as PageRunEvent })).filter((row) => row.id > (afterId ?? -1));
    },
  };
}
