import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SDKError } from '../../execution/errors';
import type { PageRunEvent } from '../contracts/execution';
import type { LedgerEvent, RunLedger, RunRecord, WorkspaceScope } from './stores';

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

function withoutTornLine(text: string | undefined): string | undefined {
  return text && !text.endsWith('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
}

function parseEvent(line: string, id: number): LedgerEvent[] {
  try {
    return [{ id, event: JSON.parse(line) as PageRunEvent }];
  } catch {
    return [];
  }
}

function byStart(a: RunRecord, b: RunRecord): number {
  return a.startedAt - b.startedAt || a.runId.localeCompare(b.runId);
}

function lockKey(scope: WorkspaceScope, runId: string): string {
  return `${scope.projectId}/${scope.workspaceId}/${runId}`;
}

export function fileRunLedger(dir: string): RunLedger {
  const root = resolve(dir);
  const runsDir = (scope: WorkspaceScope): string => join(root, 'runs', scope.projectId, scope.workspaceId);
  const eventsDir = (scope: WorkspaceScope): string => join(root, 'events', scope.projectId, scope.workspaceId);
  const tails = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return next;
  };
  const getRun: RunLedger['getRun'] = async (scope, runId) => {
    const text = await readText(join(runsDir(scope), `${runId}.json`));
    return text === undefined ? undefined : (JSON.parse(text) as RunRecord);
  };
  return {
    getRun,
    insertRun: (record) =>
      serial(lockKey(record, record.runId), async () => {
        if (await getRun(record, record.runId)) throw new SDKError(`Run ${record.runId} already exists.`, 'LOUSHO_CONFIG_INVALID');
        await mkdir(runsDir(record), { recursive: true });
        await writeFile(join(runsDir(record), `${record.runId}.json`), JSON.stringify(record));
      }),
    updateRun: (scope, runId, status, endedAt) =>
      serial(lockKey(scope, runId), async () => {
        const row = await getRun(scope, runId);
        if (!row) throw new SDKError(`Run ${runId} does not exist.`, 'LOUSHO_CONFIG_INVALID');
        const { endedAt: _previous, ...rest } = row;
        await writeFile(join(runsDir(scope), `${runId}.json`), JSON.stringify(endedAt === undefined ? { ...rest, status } : { ...rest, status, endedAt }));
      }),
    async listRuns(scope, states) {
      let names: string[] = [];
      try {
        names = await readdir(runsDir(scope));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const rows = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => getRun(scope, name.slice(0, -5))));
      return rows.filter((row): row is RunRecord => row !== undefined && (states === undefined || states.includes(row.status))).sort(byStart);
    },
    appendEvent: (scope, runId, event) =>
      serial(lockKey(scope, runId), async () => {
        await mkdir(eventsDir(scope), { recursive: true });
        const path = join(eventsDir(scope), `${runId}.ndjson`);
        const text = await readText(path);
        const clean = withoutTornLine(text);
        if (clean !== text) await writeFile(path, clean ?? '');
        const seq = eventLines(clean).length;
        await appendFile(path, `${JSON.stringify(event)}\n`);
        return seq;
      }),
    async readEvents(scope, runId, afterId) {
      const lines = eventLines(await readText(join(eventsDir(scope), `${runId}.ndjson`)));
      return lines.flatMap((line, id) => parseEvent(line, id)).filter((row) => row.id > (afterId ?? -1));
    },
  };
}
