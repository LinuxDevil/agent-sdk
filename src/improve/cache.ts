import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, ImproveLedger, ImproveOptions, ImproveStage, ProbeRun } from './types';

const CACHE_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 7 * 86_400_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 3_600_000;
const ENTRY = /^[0-9a-f]{64}\.json$/;
const TEMP = /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/;

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byKey = <T>(entries: [string, T][]) => entries.sort(([a], [b]) => a.localeCompare(b));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An empty {@link ImproveLedger} for {@link cachedProbe} to count into. */
export const emptyLedger = (): ImproveLedger => ({ planned: 0, run: 0, cached: 0, excluded: 0 });

/** The cache key of one probe run: the same model, salt, case, repeat and harness give the same key. */
export function probeCacheKey(parts: { model: string; salt: string; caseId: string; repeat: number; harness: Harness }): string {
  const { model, salt, caseId, repeat, harness } = parts;
  return sha256([model, salt, caseId, repeat, harness.instructions, byKey(Object.entries(harness.skills))]);
}

export function editorCacheKey(parts: { label: string; system: string; files: Record<string, string>; model: string; settings: unknown }): string {
  return sha256(['editor', CACHE_VERSION, parts.label, parts.system, byKey(Object.entries(parts.files)), parts.model, parts.settings]);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(dir: string, key: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}

function asProbeRun(value: unknown): ProbeRun | undefined {
  if (!isRecord(value)) return undefined;
  const { passed, transcript, tokens, ended, failure } = value;
  if (typeof passed !== 'boolean' || typeof transcript !== 'string' || typeof tokens !== 'number' || typeof ended !== 'string') return undefined;
  return { passed, transcript, tokens, ended, ...(typeof failure === 'string' && { failure }) };
}

/** Options for {@link cachedProbe}. */
export interface CachedProbeOptions {
  /** Where entries are stored, such as `<agentDir>/.lousho/cache`. */
  dir: string;
  /** The probed agent's model, part of every key. */
  model: string;
  /** Separates otherwise identical runs, such as one attempt from another (default `''`). */
  salt?: string;
  /** Counts each call into this ledger. */
  ledger?: ImproveLedger;
  /** Gives a key repeated within this wrapper its own entry, so the gate never reuses a run it already saw. */
  distinct?: boolean;
}

/** Wraps a probe so a scored run is stored and replayed, marked `cached`, for the same model, salt, case, repeat and harness; an unscored run is never stored. */
export function cachedProbe(probe: ImproveOptions['probe'], options: CachedProbeOptions): ImproveOptions['probe'] {
  const { dir, model, salt = '', ledger = emptyLedger(), distinct = false } = options;
  const seen = new Map<string, number>();
  const keyOf = (harness: Harness, caseId: string, repeat: number): string => {
    const first = probeCacheKey({ model, salt, caseId, repeat, harness });
    const nth = seen.get(first) ?? 0;
    seen.set(first, nth + 1);
    return distinct && nth > 0 ? probeCacheKey({ model, salt: `${salt}#${nth}`, caseId, repeat, harness }) : first;
  };
  return async (harness, caseId, repeat) => {
    ledger.planned += 1;
    const key = keyOf(harness, caseId, repeat);
    const hit = asProbeRun(readJson(path.join(dir, `${key}.json`)));
    if (hit) {
      ledger.cached += 1;
      return { ...hit, cached: true };
    }
    const run = await probe(harness, caseId, repeat);
    ledger.run += 1;
    if (run.passed === null) ledger.excluded += 1;
    else writeJson(dir, key, { ...run, cached: undefined });
    return run;
  };
}

export interface CachedSession {
  harness: Harness;
  stage: Pick<ImproveStage, 'status' | 'notes' | 'error'>;
}

const STATUSES: readonly unknown[] = ['edited', 'no-change'];

function asSkills(value: unknown): Harness['skills'] | undefined {
  if (!isRecord(value)) return undefined;
  const skills: Harness['skills'] = {};
  for (const [name, skill] of Object.entries(value)) {
    if (!isRecord(skill) || typeof skill.description !== 'string' || typeof skill.content !== 'string') return undefined;
    skills[name] = { description: skill.description, content: skill.content };
  }
  return skills;
}

function asSession(value: unknown): CachedSession | undefined {
  if (!isRecord(value) || !isRecord(value.harness) || !isRecord(value.stage)) return undefined;
  const { instructions } = value.harness;
  const skills = asSkills(value.harness.skills);
  const { status, notes, error } = value.stage;
  if (typeof instructions !== 'string' || !skills || !STATUSES.includes(status) || typeof notes !== 'string' || (error !== undefined && typeof error !== 'string')) return undefined;
  return { harness: { instructions, skills }, stage: { status: status as ImproveStage['status'], notes, ...(error !== undefined && { error }) } };
}

export const readSession = (dir: string, key: string) => asSession(readJson(path.join(dir, `${key}.json`)));

export const writeSession = (dir: string, key: string, session: CachedSession) => writeJson(dir, key, session);

function statOf(file: string): { size: number; mtime: number } | undefined {
  try {
    const { size, mtimeMs } = statSync(file);
    return { size, mtime: mtimeMs };
  } catch {
    return undefined;
  }
}

function filesOf(dir: string, pattern: RegExp): { file: string; size: number; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    const stat = pattern.test(name) ? statOf(file) : undefined;
    return stat ? [{ file, ...stat }] : [];
  });
}

/** Limits for {@link pruneCache}. */
export interface CacheLimits {
  /** Oldest an entry may be, in ms (default 7 days). */
  maxAgeMs?: number;
  /** Most bytes the entries may take together (default 200 MB). */
  maxBytes?: number;
  /** The current time, in ms since the epoch (default `Date.now()`). */
  now?: number;
}

/** Deletes cache entries older than `maxAgeMs`, then the oldest until the rest fit in `maxBytes`; files that aren't cache entries are left alone. */
export function pruneCache(dir: string, limits: CacheLimits = {}): void {
  const { maxAgeMs = DEFAULT_MAX_AGE_MS, maxBytes = DEFAULT_MAX_BYTES, now = Date.now() } = limits;
  for (const temp of filesOf(dir, TEMP)) if (now - temp.mtime > TEMP_MAX_AGE_MS) rmSync(temp.file, { force: true });
  const entries = filesOf(dir, ENTRY).sort((a, b) => a.mtime - b.mtime);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (now - entry.mtime <= maxAgeMs && total <= maxBytes) break;
    rmSync(entry.file, { force: true });
    total -= entry.size;
  }
}
