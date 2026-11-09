import { appendFileSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { harnessRevisionOf, sha256Hex } from '../execution/harnessRevision';
import type { Skill } from '../skills/defineSkill';
import { readAudit, verifyAudit } from './audit';
import { validateHarness } from './harness';
import { harnessHash, isHarness } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import type { Harness, ImproveResult } from './types';

/** A live traffic canary in progress, saved as `.lousho/canary.json`. */
export interface TrafficCanary {
  /** The gated harness a share of new sessions runs. */
  candidate: Harness;
  /** The candidate's harness hash, stamped on its runs. */
  revision: string;
  /** The harness the directory held when the canary started. */
  base: Harness;
  /** The base's harness hash. */
  baseRevision: string;
  /** The share of new sessions that run the candidate, at most 0.25. */
  share: number;
  /** Candidate sessions in the forward trial, at most 50. */
  sessions: number;
  /** When the canary started, as an ISO timestamp. */
  startedAt: string;
  /** The base's flagged rate over its last 20 runs when the canary started, or 1 with no history. */
  p0: number;
  /** The gated result the candidate came from, applied on a promote. */
  result: ImproveResult;
  /** The self-healing cycle that started it. */
  cycle?: string;
  /** The agent id or name its runs are filtered by. */
  agent?: string;
  /** The instructions length limit the proposal was gated with. */
  maxAlwaysOnChars?: number;
}

export const MAX_CANARY_SHARE = 0.25;
export const MAX_CANARY_SESSIONS = 50;

export const CANARY_FILE = path.join('.lousho', 'canary.json');
const STOP_FILE = path.join('.lousho', 'improve.stop');
export const SESSIONS_FILE = path.join('.lousho', 'canary-sessions.txt');
const AUDIT_FILE = path.join('.lousho', 'audit.jsonl');
export const DEFAULT_MAX_ALWAYS_ON = 8000;

const SHA = /^[0-9a-f]{64}$/;

function refuse(message: string): never {
  throw new ConfigurationError(`readCanary: ${message}`, 'canary');
}

function isTrial(value: TrafficCanary): boolean {
  const { share, sessions, p0 } = value;
  return typeof share === 'number' && share > 0 && share <= MAX_CANARY_SHARE && Number.isInteger(sessions) && sessions > 0 && sessions <= MAX_CANARY_SESSIONS && typeof p0 === 'number' && p0 >= 0 && p0 <= 1;
}

function isShaped(value: TrafficCanary): boolean {
  if (!isHarness(value.candidate) || !isHarness(value.base) || typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return false;
  if (!SHA.test(value.revision) || value.revision !== harnessHash(value.candidate) || value.baseRevision !== harnessHash(value.base)) return false;
  return value.result?.outcome === 'proposal' && isHarness(value.result.harness) && harnessHash(value.result.harness) === value.revision;
}

function startedInAudit(dir: string, canary: TrafficCanary): boolean {
  const entries = readAudit(dir);
  const started = entries.map((entry) => entry.action).lastIndexOf('canary-start');
  const start = entries[started];
  if (start?.from !== canary.baseRevision || start.to !== canary.revision) return false;
  const ended = entries.slice(started + 1).some((entry) => entry.action === 'canary-end' && entry.from === canary.baseRevision && entry.to === canary.revision);
  return !ended && verifyAudit(dir) === undefined;
}

function checked(dir: string, value: TrafficCanary): TrafficCanary {
  if (!isShaped(value)) refuse('canary.json does not match its revisions; it was edited or is corrupted.');
  if (!isTrial(value)) refuse(`canary.json asks for more than the caps allow (share ≤ ${MAX_CANARY_SHARE}, sessions ≤ ${MAX_CANARY_SESSIONS}).`);
  const failedChecks = Array.isArray(value.result.failedChecks) ? value.result.failedChecks : [];
  const errors = validateHarness(value.candidate, value.base, { maxAlwaysOnChars: value.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON, failedChecks });
  if (errors.length > 0) refuse(`the candidate fails validation: ${errors.join(' ')}`);
  if (!startedInAudit(dir, value)) refuse('the audit log has no matching canary-start entry, or its hash chain is broken.');
  return value;
}

/** The directory's traffic canary, checked against its revisions, the caps, the validator and the audit log; undefined when none is running. */
export function readCanary(dir: string): TrafficCanary | undefined {
  const file = path.join(dir, CANARY_FILE);
  for (const part of [path.join(dir, '.lousho'), file]) if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) refuse(`${part} is a symlink.`);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`canary.json is not valid JSON (${(error as Error).message}).`);
  }
  if (typeof value !== 'object' || value === null) refuse('canary.json is not an object.');
  return checked(dir, value as TrafficCanary);
}

/** Whether a session runs the candidate: a stable hash of its id, below `share` (capped at 0.25) in a thousand. */
export function routesToCandidate(sessionId: string, share: number): boolean {
  const capped = Math.min(Math.max(share, 0), MAX_CANARY_SHARE);
  return parseInt(sha256Hex(`lousho-canary:${sessionId}`).slice(0, 8), 16) % 1000 < Math.round(capped * 1000);
}

export function isPaused(dir: string, settings: ImproveSettings, env: NodeJS.ProcessEnv): boolean {
  return !settings.enabled || env.LOUSHO_IMPROVE === 'off' || statSync(path.join(dir, STOP_FILE), { throwIfNoEntry: false }) !== undefined;
}

export function trafficOptedIn(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return loadImproveSettings(dir, {}, env).canary.traffic !== undefined;
  } catch {
    return false;
  }
}

interface Serving {
  key: string;
  arm?: { instructions: string; skills: Skill[] };
  share: number;
  cap: number;
  trial: string;
}

function stamp(file: string): string {
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats ? `${stats.ino}:${stats.size}:${stats.mtimeMs}` : '-';
}

function armSkills(candidate: Harness, skills: readonly Skill[]): Skill[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return Object.entries(candidate.skills).map(([name, skill]) => ({ ...byName.get(name), name, description: skill.description, content: skill.content }));
}

function serving(dir: string, baseRevision: string, skills: readonly Skill[], env: NodeJS.ProcessEnv, key: string): Serving {
  const closed = { key, share: 0, cap: 0, trial: '' };
  try {
    const settings = loadImproveSettings(dir, {}, env);
    const traffic = settings.canary.traffic;
    if (!traffic || isPaused(dir, settings, env)) return closed;
    const canary = readCanary(dir);
    if (!canary || canary.baseRevision !== baseRevision) return closed;
    const arm = { instructions: canary.candidate.instructions, skills: armSkills(canary.candidate, skills) };
    return { key, arm, share: Math.min(canary.share, traffic.share), cap: Math.min(canary.sessions, traffic.sessions), trial: `${canary.revision}:${canary.startedAt}` };
  } catch {
    return closed;
  }
}

interface Router {
  dir: string;
  baseRevision: string;
  skills: readonly Skill[];
  env: NodeJS.ProcessEnv;
  files: string[];
  state: Serving;
  trial: string;
  served: Set<string>;
}

function refreshed(router: Router): Serving {
  const key = `${router.files.map(stamp).join('|')}|${router.env.LOUSHO_IMPROVE ?? ''}`;
  if (key !== router.state.key) router.state = serving(router.dir, router.baseRevision, router.skills, router.env, key);
  if (router.state.trial !== '' && router.state.trial !== router.trial) {
    router.trial = router.state.trial;
    router.served = new Set();
  }
  return router.state;
}

function servedSessions(dir: string, trial: string): Set<string> {
  let text = '';
  try {
    text = readFileSync(path.join(dir, SESSIONS_FILE), 'utf8');
  } catch {
    text = '';
  }
  const prefix = `${trial} `;
  return new Set(text.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)));
}

function admitted(router: Router, sessionId: string, cap: number): boolean {
  const id = sha256Hex(`lousho-canary-session:${sessionId}`).slice(0, 32);
  const served = servedSessions(router.dir, router.trial);
  if (!served.has(id)) {
    if (served.size >= cap) return false;
    appendFileSync(path.join(router.dir, SESSIONS_FILE), `${router.trial} ${id}\n`);
  }
  router.served.add(sessionId);
  return true;
}

function pick(router: Router, sessionId: string | undefined): { instructions: string; skills: Skill[] } | undefined {
  const { arm, cap, share } = refreshed(router);
  if (!arm || sessionId === undefined || sessionId === '') return undefined;
  if (router.served.has(sessionId)) return arm;
  if (!routesToCandidate(sessionId, share)) return undefined;
  try {
    return admitted(router, sessionId, cap) ? arm : undefined;
  } catch {
    return undefined;
  }
}

/** Per run, the candidate harness a routed session serves while a valid, opted-in canary runs; undefined otherwise, and on any error. */
export function canaryArm(dir: string, base: { instructions: string; skills: readonly Skill[] }, env: NodeJS.ProcessEnv = process.env): (ctx: { sessionId?: string }) => { instructions: string; skills: Skill[] } | undefined {
  const files = [CANARY_FILE, STOP_FILE, AUDIT_FILE, 'improve.json'].map((name) => path.join(dir, name));
  const router: Router = { dir, baseRevision: harnessRevisionOf(base.instructions, base.skills), skills: base.skills, env, files, state: { key: '', share: 0, cap: 0, trial: '' }, trial: '', served: new Set() };
  return (ctx) => pick(router, ctx.sessionId);
}
