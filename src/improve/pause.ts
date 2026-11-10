import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendAudit, type AuditEntry } from './audit';
import { ownLousho } from './cycles';
import { updateState } from './state';
import type { WatchState } from './watchSteps';

const STOP_FILE = path.join('.lousho', 'improve.stop');

function stopFile(dir: string): string {
  return path.join(ownLousho(dir), 'improve.stop');
}

const actorOf = (by: string | undefined): AuditEntry['actor'] => (by === undefined || by.trim() === '' ? 'scheduler' : `person:${by.trim()}`);

/** Turns the self-healing loop off for a directory by writing .lousho/improve.stop, and audits `pause` once. */
export async function pauseImprove(dir: string, options: { by?: string; reason?: string } = {}): Promise<boolean> {
  const file = stopFile(dir);
  if (lstatSync(file, { throwIfNoEntry: false })) return false;
  const reason = options.reason?.trim() || 'Paused from the command line.';
  writeFileSync(file, `${reason}\n`, { flag: 'wx' });
  await appendAudit(dir, { actor: actorOf(options.by), action: 'pause', reason });
  await updateState<WatchState>(dir, (current) => ({ watch: { ...current.watch, paused: `${STOP_FILE} exists` } }));
  return true;
}

/** Removes .lousho/improve.stop and audits `resume`; `improve.json` `enabled: false` and `LOUSHO_IMPROVE=off` still stop the loop. */
export async function resumeImprove(dir: string, options: { by?: string } = {}): Promise<boolean> {
  const file = stopFile(dir);
  if (!lstatSync(file, { throwIfNoEntry: false })) return false;
  rmSync(file, { force: true });
  await appendAudit(dir, { actor: actorOf(options.by), action: 'resume', reason: 'The stop file was removed.' });
  await updateState<WatchState>(dir, (current) => {
    const { paused: _paused, ...rest } = current.watch ?? {};
    return { watch: rest };
  });
  return true;
}
