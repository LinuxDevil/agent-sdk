import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pointOf, significantDrop, trajectoryGate, windowSummary, type ScorePoint, type WindowStat } from '../observe/continuousScore';
import { finishedRuns } from '../observe/store';
import { ConfigurationError } from '../execution/errors';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { writeFileAtomic } from '../storage/atomicFile';
import { withFileLock } from '../storage/fileLock';
import { rollbackHarness } from './apply';
import { appendAudit, readAudit, type AuditEntry } from './audit';
import { currentRevision } from './revisions';
import type { ImproveSettings } from './settings';

/** What the monitor decided about the current revision. */
export interface MonitorVerdict {
  /** `idle` with nothing to watch, `pending` until there are enough runs, then `kept`, `kept-unverified`, `regressed` (reported, not rolled back) or `rolled-back`. */
  state: 'idle' | 'pending' | 'kept' | 'kept-unverified' | 'regressed' | 'rolled-back';
  /** Why, for `idle`, `kept-unverified`, `regressed` and `rolled-back`. */
  reason?: string;
  /** Finished runs under the current revision so far, for `pending` and `kept-unverified`. */
  runs?: number;
  /** Finished runs of the revision before it, for `pending` and `kept-unverified`. */
  baselineRuns?: number;
  /** The runs before the apply that were compared. */
  before?: WindowStat;
  /** The runs after the apply that were compared. */
  after?: WindowStat;
  /** The revision restored, for `rolled-back`. */
  to?: string;
}

/** The comparison of the runs before and after an apply, without side effects. */
export type MonitorJudgement = { verdict: 'wait' } | { verdict: 'kept'; before: WindowStat; after: WindowStat } | { verdict: 'regressed'; before: WindowStat; after: WindowStat; reason: string };

type MonitorSettings = ImproveSettings['monitor'];
type CheckSettings = Pick<ImproveSettings, 'monitor' | 'cooldownHours'>;

const LOOKS = 3;
const LOOK_Z = 2.1;
const GATE_WINDOW = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SERIES_LIMIT = 100_000;
const STATE_FILE = path.join('.lousho', 'state.json');
const STATE_LOCK = path.join('.lousho', 'state.lock');
const MONITOR_LOCK = path.join('.lousho', 'monitor.lock');
const FINAL: readonly MonitorVerdict['state'][] = ['kept', 'kept-unverified', 'regressed', 'rolled-back'];

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const binary = (points: readonly ScorePoint[]): boolean => points.every((point) => point.value === 0 || point.value === 1);
const passes = (points: readonly ScorePoint[]): number[] => points.map((point) => (point.value >= 0.5 ? 1 : 0));

function regression(before: readonly ScorePoint[], after: readonly ScorePoint[], b: WindowStat, a: WindowStat, maxDrop: number): string | undefined {
  if (b.passRate - a.passRate > maxDrop && significantDrop(passes(before), passes(after), LOOK_Z)) return `The pass rate fell from ${percent(b.passRate)} to ${percent(a.passRate)} over ${a.runs} runs.`;
  if (binary(before) && binary(after)) return undefined;
  const gate = trajectoryGate([...before, ...after], { window: GATE_WINDOW, drop: maxDrop, z: LOOK_Z });
  if (b.mean - a.mean > maxDrop && gate.state === 'regression') return `The mean score fell from ${b.mean.toFixed(2)} to ${gate.mean.toFixed(2)} over the newest ${GATE_WINDOW} runs.`;
  return undefined;
}

/** Compares the first runs after an apply with the last runs before it, in up to three looks of `window` runs, at a per-look z of 2.1 that keeps the overall false rollback rate under one-sided 5%. */
export function judgeApplied(before: readonly ScorePoint[], after: readonly ScorePoint[], settings: MonitorSettings): MonitorJudgement {
  const minRuns = Math.max(settings.minRuns, settings.window);
  if (after.length < minRuns || before.length < minRuns) return { verdict: 'wait' };
  const looks = Math.min(LOOKS, Math.floor(after.length / settings.window));
  const size = looks * settings.window;
  const later = after.slice(0, size);
  const earlier = before.slice(-size);
  const b = windowSummary(earlier);
  const a = windowSummary(later);
  const reason = regression(earlier, later, b, a, settings.maxDrop);
  if (reason !== undefined) return { verdict: 'regressed', before: b, after: a, reason };
  const dropped = b.passRate - a.passRate > settings.maxDrop || b.mean - a.mean > settings.maxDrop;
  return dropped && looks < LOOKS ? { verdict: 'wait' } : { verdict: 'kept', before: b, after: a };
}

interface MonitorState {
  cooldownUntil?: string;
  monitor?: { revision: string; applySeq: number; at: string; verdict: MonitorVerdict };
  [key: string]: unknown;
}

function readState(dir: string): MonitorState {
  const file = path.join(dir, STATE_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConfigurationError(`${file} is not a JSON object; fix or delete it before the monitor runs.`, 'state', 'LOUSHO_CONFIG_INVALID');
  return parsed as MonitorState;
}

async function writeState(dir: string, change: Partial<MonitorState>): Promise<void> {
  await withFileLock(path.join(dir, STATE_LOCK), async () => {
    await writeFileAtomic(path.join(dir, STATE_FILE), `${JSON.stringify({ ...readState(dir), ...change }, null, 2)}\n`);
  });
}

function lastApply(dir: string, current: string): AuditEntry | string {
  const change = readAudit(dir)
    .filter((entry) => entry.action === 'apply' || entry.action === 'rollback')
    .at(-1);
  if (change?.action !== 'apply' || change.from === undefined) return 'No applied revision to watch.';
  if (change.to !== current) return 'The directory changed by hand after the last apply, so the monitor leaves it alone.';
  return change;
}

function seriesAround(db: SqlDatabase, apply: AuditEntry, settings: MonitorSettings, agent: string): { before: ScorePoint[]; after: ScorePoint[] } {
  const appliedAt = Date.parse(apply.at);
  const before = finishedRuns(db, { agentId: agent, revision: apply.from, endedBefore: appliedAt, byEnd: true, limit: LOOKS * settings.window }).reverse().map(pointOf);
  const after = finishedRuns(db, { agentId: agent, revision: apply.to, since: appliedAt, byEnd: true, limit: SERIES_LIMIT }).reverse().map(pointOf);
  return { before, after };
}

const score = (before: WindowStat, after: WindowStat) => ({ score: { before: before.passRate, after: after.passRate, runs: after.runs } });

async function settle(dir: string, apply: AuditEntry, verdict: MonitorVerdict, now: number): Promise<MonitorVerdict> {
  await writeState(dir, { monitor: { revision: apply.to as string, applySeq: apply.seq, at: new Date(now).toISOString(), verdict } });
  return verdict;
}

async function rollBack(dir: string, apply: AuditEntry, judged: Extract<MonitorJudgement, { verdict: 'regressed' }>, now: number, cooldownHours: number): Promise<MonitorVerdict> {
  await writeState(dir, { cooldownUntil: new Date(now + cooldownHours * HOUR_MS).toISOString() });
  let to: string;
  try {
    to = (await rollbackHarness(dir, apply.from as string, { actor: 'monitor', reason: judged.reason, expectedFrom: apply.to })).to;
  } catch (error) {
    await appendAudit(dir, { actor: 'monitor', action: 'guard-fail', from: apply.from, to: apply.to, reason: `${judged.reason} The rollback was refused: ${error instanceof Error ? error.message : String(error)}`, evidence: score(judged.before, judged.after) });
    return settle(dir, apply, { state: 'regressed', before: judged.before, after: judged.after, reason: `${judged.reason} The rollback was refused.` }, now);
  }
  await appendAudit(dir, { actor: 'monitor', action: 'retire', from: apply.to, to, reason: judged.reason, evidence: score(judged.before, judged.after) });
  return settle(dir, apply, { state: 'rolled-back', to, before: judged.before, after: judged.after, reason: judged.reason }, now);
}

async function decide(dir: string, apply: AuditEntry, judged: Exclude<MonitorJudgement, { verdict: 'wait' }>, settings: CheckSettings, now: number): Promise<MonitorVerdict> {
  if (judged.verdict === 'kept') {
    await appendAudit(dir, { actor: 'monitor', action: 'guard-pass', from: apply.from, to: apply.to, reason: `Kept: ${judged.after.runs} runs held the pass rate at ${percent(judged.after.passRate)} against ${percent(judged.before.passRate)}.`, evidence: score(judged.before, judged.after) });
    return settle(dir, apply, { state: 'kept', before: judged.before, after: judged.after }, now);
  }
  if (settings.monitor.autoRollback) return rollBack(dir, apply, judged, now, settings.cooldownHours);
  await appendAudit(dir, { actor: 'monitor', action: 'guard-fail', from: apply.from, to: apply.to, reason: `${judged.reason} Automatic rollback is off.`, evidence: score(judged.before, judged.after) });
  return settle(dir, apply, { state: 'regressed', before: judged.before, after: judged.after, reason: judged.reason }, now);
}

function unverifiedReason(after: number, before: number, settings: MonitorSettings): string {
  const minRuns = Math.max(settings.minRuns, settings.window);
  if (after < minRuns) return `Kept unverified: ${after} runs after ${settings.giveUpDays} days, fewer than the ${minRuns} the monitor needs.`;
  if (before < minRuns) return `Kept unverified: the revision before it has only ${before} runs to compare with.`;
  return `Kept unverified: after ${settings.giveUpDays} days the ${after} runs neither held nor clearly fell.`;
}

function agentIdOf(db: SqlDatabase, agent: string): string {
  if (agent.trim() === '') throw new ConfigurationError('checkApplied needs the agent whose runs it judges; got an empty name.', 'agent');
  if (db.prepare('SELECT 1 AS hit FROM agents WHERE agent_id = ?').get(agent) !== undefined) return agent;
  const named = db.prepare('SELECT agent_id FROM agents WHERE name = ?').all(agent).map((row) => String(row.agent_id));
  if (named.length > 1) throw new ConfigurationError(`'${agent}' names ${named.length} agents (${named.join(', ')}); pass the agent_id.`, 'agent');
  return named[0] ?? agent;
}

async function check(db: SqlDatabase, dir: string, settings: CheckSettings, now: number, name: string): Promise<MonitorVerdict> {
  const agent = agentIdOf(db, name);
  const apply = lastApply(dir, currentRevision(dir));
  if (typeof apply === 'string') return { state: 'idle', reason: apply };
  const stored = readState(dir).monitor;
  if (stored?.applySeq === apply.seq && FINAL.includes(stored.verdict.state)) return stored.verdict;
  const { before, after } = seriesAround(db, apply, settings.monitor, agent);
  const judged = judgeApplied(before, after, settings.monitor);
  if (judged.verdict !== 'wait') return decide(dir, apply, judged, settings, now);
  if (now - Date.parse(apply.at) < settings.monitor.giveUpDays * DAY_MS) return { state: 'pending', runs: after.length, baselineRuns: before.length };
  const reason = unverifiedReason(after.length, before.length, settings.monitor);
  await appendAudit(dir, { actor: 'monitor', action: 'unverified', from: apply.from, to: apply.to, reason });
  return settle(dir, apply, { state: 'kept-unverified', runs: after.length, baselineRuns: before.length, reason }, now);
}

/** Compares runs of `agent` (its id or registered name) under the current revision with its runs before the apply, and rolls back on a regression. */
export async function checkApplied(db: SqlDatabase, dir: string, settings: Pick<ImproveSettings, 'monitor' | 'cooldownHours'>, options: { agent: string; now?: number }): Promise<MonitorVerdict> {
  mkdirSync(path.join(dir, '.lousho'), { recursive: true });
  return withFileLock(path.join(dir, MONITOR_LOCK), () => check(db, dir, settings, options.now ?? Date.now(), options.agent));
}
