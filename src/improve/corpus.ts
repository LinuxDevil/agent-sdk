import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { withFileLock } from '../storage/fileLock';
import type { CaseCount } from './types';

/** A case that must keep passing under every later revision. */
export interface CorpusCase {
  /** The case id the gate and the guard use; unique in the corpus. */
  id: string;
  /** The trace it was captured from; one corpus case per trace. */
  traceId: string;
  /** The recorded input, as captured; never shown to an editor. */
  input: string;
  /** When it joined the corpus, as an ISO timestamp. */
  addedAt: string;
  /** The revision it was admitted under. */
  revision: string;
  /** `protected`: a run that went well; `fixed`: a training case a kept edit fixed. */
  origin: 'protected' | 'fixed';
  /** Its pass count when admitted, which the guard compares against. */
  baseline: CaseCount;
}

const LOUSHO = '.lousho';
const FILE = path.join(LOUSHO, 'corpus.json');
const ORIGINS: readonly string[] = ['protected', 'fixed'];

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

function isCount(value: unknown): value is CaseCount {
  const count = value as CaseCount | undefined;
  if (!Number.isInteger(count?.passed) || !Number.isInteger(count?.scored)) return false;
  return (count as CaseCount).scored >= 1 && (count as CaseCount).passed >= 0 && (count as CaseCount).passed <= (count as CaseCount).scored;
}

function isCase(value: unknown): value is CorpusCase {
  const item = value as CorpusCase | undefined;
  if (![item?.id, item?.traceId, item?.revision].every(filled) || typeof item?.input !== 'string') return false;
  return Number.isFinite(Date.parse(String(item.addedAt))) && ORIGINS.includes(String(item.origin)) && isCount(item.baseline);
}

function refuse(message: string, field = 'corpus'): never {
  throw new ConfigurationError(message, field);
}

function guardPaths(dir: string): string {
  if (lstatSync(path.join(dir, LOUSHO), { throwIfNoEntry: false })?.isSymbolicLink()) refuse(`${path.join(dir, LOUSHO)} is a symlink; the corpus must live inside the agent directory.`);
  const file = path.join(dir, FILE);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) refuse(`${file} is not a regular file. Fix or delete it.`);
  return file;
}

function duplicate(cases: readonly CorpusCase[]): string | undefined {
  const ids = new Set<string>();
  const traces = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id) || traces.has(item.traceId)) return item.id;
    ids.add(item.id);
    traces.add(item.traceId);
  }
  return undefined;
}

/** Reads .lousho/corpus.json; empty when there is none, and throws when it is broken. */
export function readCorpus(dir: string): CorpusCase[] {
  const file = guardPaths(dir);
  if (!lstatSync(file, { throwIfNoEntry: false })) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`readCorpus: ${file} is not valid JSON (${(error as Error).message}). Fix or delete it.`);
  }
  const cases = typeof parsed === 'object' && parsed !== null ? (parsed as { cases?: unknown }).cases : undefined;
  if (!Array.isArray(cases) || !cases.every(isCase)) return refuse(`readCorpus: ${file} does not hold a list of corpus cases. Fix or delete it.`);
  const twice = duplicate(cases);
  if (twice !== undefined) refuse(`readCorpus: ${file} holds case ${twice} twice. Fix or delete it.`);
  return cases;
}

function evict(cases: CorpusCase[], maxCases: number): CorpusCase[] {
  const fixed = cases.filter((item) => item.origin === 'fixed').sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
  const drop = new Set(fixed.slice(0, Math.max(0, cases.length - maxCases)).map((item) => item.traceId));
  return cases.filter((item) => !drop.has(item.traceId));
}

function save(file: string, cases: readonly CorpusCase[]): void {
  const temp = path.join(path.dirname(file), `.corpus.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ cases }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function admitted(current: readonly CorpusCase[], cases: readonly CorpusCase[]): CorpusCase[] {
  const byTrace = new Map(current.map((item) => [item.traceId, item.id]));
  const byId = new Map(current.map((item) => [item.id, item.traceId]));
  const added: CorpusCase[] = [];
  for (const item of cases) {
    if (byTrace.has(item.traceId)) continue;
    if (byId.has(item.id)) refuse(`addToCorpus: case id ${item.id} is already used by trace ${byId.get(item.id)}; ids must be unique.`, 'cases');
    byTrace.set(item.traceId, item.id);
    byId.set(item.id, item.traceId);
    added.push(item);
  }
  return added;
}

/** Adds admitted cases, dropping the oldest 'fixed' cases over maxCases (a new case can be the one dropped); protected cases are never evicted automatically. */
export async function addToCorpus(dir: string, cases: readonly CorpusCase[], maxCases: number): Promise<CorpusCase[]> {
  if (!Number.isInteger(maxCases) || maxCases < 1) refuse(`addToCorpus: maxCases must be a positive integer, not ${maxCases}.`, 'maxCases');
  if (!cases.every(isCase)) refuse('addToCorpus: every case needs a non-empty id, traceId and revision, an input, an ISO addedAt, an origin and a baseline with 0 <= passed <= scored and scored >= 1.', 'cases');
  guardPaths(dir);
  mkdirSync(path.join(dir, LOUSHO), { recursive: true });
  return withFileLock(path.join(dir, `${FILE}.lock`), async () => {
    const current = readCorpus(dir);
    const next = evict([...current, ...admitted(current, cases)], maxCases);
    save(guardPaths(dir), next);
    return next;
  });
}
