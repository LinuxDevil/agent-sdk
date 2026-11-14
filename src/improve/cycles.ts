import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { readAudit } from './audit';
import { readState, updateState } from './state';
import type { CanaryReplayResult } from './canary';
import type { GuardCorpusResult } from './corpusGuard';
import type { ImproveSettings } from './settings';
import type { ImproveOutcome, ImproveResult } from './types';

/** What one self-healing cycle did. */
export interface HealCycle {
  /** The cycle id, which sorts by start time. */
  id: string;
  /** What started it: new failed runs, a score regression, or a person running `lousho improve`. */
  trigger: 'failures' | 'score' | 'manual';
  /** The approval mode it ran under. */
  approval: ImproveSettings['approval'];
  /** How it ended. `interrupted` is left on disk when a cycle stopped before it finished. */
  outcome:
    | 'idle'
    | 'paused'
    | 'busy'
    | 'budget'
    | 'cooldown'
    | Exclude<ImproveOutcome, 'proposal'>
    | 'canary-failed'
    | 'canary-started'
    | 'applied'
    | 'pending'
    | 'guard-rolled-back'
    | 'stale'
    | 'refused'
    | 'interrupted';
  /** Why, as plain text. */
  reason: string;
  /** When it started, as an ISO timestamp. */
  startedAt: string;
  /** When it ended, as an ISO timestamp. */
  endedAt?: string;
  /** The improvement result, when the editors ran. */
  result?: ImproveResult;
  /** The replay canary's verdict, when it ran. */
  canary?: CanaryReplayResult;
  /** The corpus guard's verdict after an apply. */
  guard?: GuardCorpusResult;
  /** The pending proposal id, in manual mode. */
  pending?: string;
  /** The revision the cycle started from. */
  from?: string;
  /** The revision it applied. */
  to?: string;
  /** The revision the corpus guard rolled back to. */
  rolledBackTo?: string;
  /** Tokens it spent on runs, editors and reflection. */
  tokens: number;
  /** Runs that failed and were left unscored, one message each. */
  errors?: string[];
}

const LOUSHO = '.lousho';
const FOLDER = path.join(LOUSHO, 'cycles');
const STOP_FILE = path.join(LOUSHO, 'improve.stop');
const ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const AUTO_ACTORS: readonly string[] = ['gate', 'canary'];

export function ownLousho(dir: string): string {
  const lousho = path.join(dir, LOUSHO);
  if (lstatSync(lousho, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConfigurationError(`${lousho} is a symlink; the self-healing state must live inside the agent directory.`, 'dir');
  mkdirSync(lousho, { recursive: true });
  return lousho;
}

/** A new cycle id: its UTC start time and a random suffix. */
export function newCycleId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function folderOf(dir: string): string {
  for (const part of [path.join(dir, LOUSHO), path.join(dir, FOLDER)]) {
    if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConfigurationError(`${part} is a symlink; cycle records must live inside the agent directory.`, 'cycles');
  }
  return path.join(dir, FOLDER);
}

/** Saves a cycle record as .lousho/cycles/<id>.json, replacing an earlier save of the same cycle. */
export function writeCycle(dir: string, cycle: HealCycle): void {
  if (!ID.test(cycle.id)) throw new ConfigurationError(`writeCycle: '${cycle.id}' is not a cycle id.`, 'id');
  const folder = folderOf(dir);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${cycle.id}.json`);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(cycle, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readCycle(file: string, id: string): HealCycle | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as HealCycle;
    return value?.id === id && typeof value.startedAt === 'string' && typeof value.outcome === 'string' && Number.isFinite(value.tokens) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Saved cycle records, newest first; unreadable files are left out. */
export function readCycles(dir: string): HealCycle[] {
  const folder = folderOf(dir);
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(folder)
    .flatMap((name) => {
      const id = name.slice(0, -'.json'.length);
      return name.endsWith('.json') && ID.test(id) ? (readCycle(path.join(folder, name), id) ?? []) : [];
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

const dayStart = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

/** Cycles, tokens (the watcher's own guard and corpus runs included) and automatic applies so far in the current UTC day. */
export function usageToday(dir: string, now: number): { cycles: number; tokens: number; applies: number } {
  const since = dayStart(now);
  const today = readCycles(dir).filter((cycle) => Date.parse(cycle.startedAt) >= since);
  const applies = readAudit(dir).filter((entry) => entry.action === 'apply' && AUTO_ACTORS.includes(entry.actor) && Date.parse(entry.at) >= since).length;
  const watch = readState<{ watch?: { spentDay?: number; spent?: number } }>(dir).watch;
  const watcher = watch?.spentDay === since ? (watch.spent ?? 0) : 0;
  return { cycles: today.length, tokens: watcher + today.reduce((sum, cycle) => sum + cycle.tokens, 0), applies };
}

export async function addSpentToday(dir: string, tokens: number, now: number): Promise<void> {
  if (tokens <= 0) return;
  const day = dayStart(now);
  await updateState<{ watch?: { spentDay?: number; spent?: number } }>(dir, (current) => {
    const watch = current.watch ?? {};
    return { watch: { ...watch, spentDay: day, spent: (watch.spentDay === day ? (watch.spent ?? 0) : 0) + tokens } };
  });
}

/** When the cooldown after the latest rollback ends, in epoch ms, or `undefined` when none is active. */
export function cooldownEnds(dir: string, hours: number, now: number): number | undefined {
  const last = readAudit(dir).reverse().find((entry) => entry.action === 'rollback');
  if (!last) return undefined;
  const ends = Date.parse(last.at) + hours * HOUR_MS;
  return ends > now ? ends : undefined;
}

/** Why the loop is switched off for a directory, or `undefined` when it may run: the stop file, `LOUSHO_IMPROVE=off`, or `enabled: false`. */
export function pausedBy(dir: string, settings: Pick<ImproveSettings, 'enabled'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (lstatSync(path.join(dir, STOP_FILE), { throwIfNoEntry: false })) return `${STOP_FILE} exists`;
  if (env.LOUSHO_IMPROVE?.trim().toLowerCase() === 'off') return 'LOUSHO_IMPROVE is off';
  if (!settings.enabled) return 'improve.json sets enabled to false';
  return undefined;
}
