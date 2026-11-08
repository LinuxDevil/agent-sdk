import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scoreSeries, significantDrop, trajectoryGate, windowSummary, type ScorePoint, type WindowStat } from '../observe/continuousScore';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { writeFileAtomic } from '../storage/atomicFile';
import { rollbackHarness } from './apply';
import { appendAudit, readAudit, type AuditEntry } from './audit';
import { currentRevision } from './revisions';
import type { ImproveSettings } from './settings';

type MonitorSettings = ImproveSettings['monitor'];

/** What the monitor decided about the current revision. */
export interface MonitorVerdict {
  /** `idle` with nothing to watch, `pending` until there are enough runs, then `kept`, `kept-unverified`, `regressed` (reported, not rolled back) or `rolled-back`. */
  state: 'idle' | 'pending' | 'kept' | 'kept-unverified' | 'regressed' | 'rolled-back';
  /** Why, for `idle`, `regressed` and `rolled-back`. */
  reason?: string;
  /** Finished runs under the current revision so far, for `pending` and `kept-unverified`. */
  runs?: number;
  /** Finished runs of the revision before it, for `pending`. */
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

const LOOKS = 3;
const LOOK_Z = 2.1;
const GATE_WINDOW = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SERIES_LIMIT = 100_000;
const STATE_FILE = path.join('.lousho', 'state.json');
const FINAL: readonly MonitorVerdict['state'][] = ['kept', 'kept-unverified', 'regressed', 'rolled-back'];

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const binary = (points: readonly ScorePoint[]): boolean => points.every((point) => point.value === 0 || point.value === 1);
const passes = (points: readonly ScorePoint[]): number[] => points.map((point) => (point.value >= 0.5 ? 1 : 0));

function regression(before: readonly ScorePoint[], after: readonly ScorePoint[], b: WindowStat, a: WindowStat, maxDrop: number): string | undefined {
  if (b.passRate - a.passRate > maxDrop && significantDrop(passes(before), passes(after), LOOK_Z)) return `The pass rate fell from ${percent(b.passRate)} to ${percent(a.passRate)} over ${a.runs} runs.`;
  if (binary(before) && binary(after)) return undefined;
  const gate = trajectoryGate([...before, ...after], { window: GATE_WINDOW, z: LOOK_Z });
  if (b.mean - a.mean > maxDrop && gate.state === 'regression') return `The mean score fell from ${b.mean.toFixed(2)} to ${a.mean.toFixed(2)} over ${a.runs} runs.`;
  return undefined;
}

/** Compares the first runs after an apply with the last runs before it, in up to three looks of `window` runs, at a per-look z of 2.1 that keeps the overall false rollback rate under one-sided 5%. */
export function judgeApplied(before: readonly ScorePoint[], after: readonly ScorePoint[], settings: MonitorSettings): MonitorJudgement {
  if (after.length < settings.minRuns || before.length < settings.minRuns) return { verdict: 'wait' };
  const looks = Math.min(LOOKS, Math.floor(after.length / settings.window));
  const size = looks >= 1 ? looks * settings.window : after.length;
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
  monitor?: { revision: string; at: string; verdict: MonitorVerdict };
  [key: string]: unknown;
}

function readState(dir: string): MonitorState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as MonitorState) : {};
  } catch {
    return {};
  }
}

async function writeState(dir: string, change: Partial<MonitorState>): Promise<void> {
  await writeFileAtomic(path.join(dir, STATE_FILE), `${JSON.stringify({ ...readState(dir), ...change }, null, 2)}\n`);
}

function lastApply(dir: string, current: string): AuditEntry | string {
  const change = readAudit(dir)
    .filter((entry) => entry.action === 'apply' || entry.action === 'rollback')
    .at(-1);
  if (change?.action !== 'apply' || change.from === undefined) return 'No applied revision to watch.';
  if (change.to !== current) return 'The directory changed by hand after the last apply, so the monitor leaves it alone.';
  return change;
}

function seriesAround(db: SqlDatabase, apply: AuditEntry, settings: MonitorSettings, agent: string | undefined): { before: ScorePoint[]; after: ScorePoint[] } {
  const appliedAt = Date.parse(apply.at);
  const scope = agent === undefined ? {} : { agent };
  const after = scoreSeries(db, { ...scope, revision: apply.to as string, since: appliedAt, limit: SERIES_LIMIT });
  const before = scoreSeries(db, { ...scope, revision: apply.from as string, limit: SERIES_LIMIT }).filter((point) => point.at < appliedAt);
  return { before: before.slice(-LOOKS * settings.window), after };
}

const score = (before: WindowStat, after: WindowStat) => ({ score: { before: before.passRate, after: after.passRate, runs: after.runs } });

async function settle(dir: string, apply: AuditEntry, verdict: MonitorVerdict, now: number, extra: Partial<MonitorState> = {}): Promise<MonitorVerdict> {
  await writeState(dir, { ...extra, monitor: { revision: apply.to as string, at: new Date(now).toISOString(), verdict } });
  return verdict;
}

async function rollBack(dir: string, apply: AuditEntry, judged: Extract<MonitorJudgement, { verdict: 'regressed' }>, now: number, cooldownHours: number): Promise<MonitorVerdict> {
  const from = apply.from as string;
  await rollbackHarness(dir, from, { actor: 'monitor', reason: judged.reason, expectedFrom: apply.to });
  await appendAudit(dir, { actor: 'monitor', action: 'retire', from: apply.to, to: from, reason: judged.reason, evidence: score(judged.before, judged.after) });
  const verdict: MonitorVerdict = { state: 'rolled-back', to: from, before: judged.before, after: judged.after, reason: judged.reason };
  return settle(dir, apply, verdict, now, { cooldownUntil: new Date(now + cooldownHours * HOUR_MS).toISOString() });
}

async function decide(dir: string, apply: AuditEntry, judged: Exclude<MonitorJudgement, { verdict: 'wait' }>, settings: MonitorSettings, now: number, cooldownHours: number): Promise<MonitorVerdict> {
  if (judged.verdict === 'kept') {
    await appendAudit(dir, { actor: 'monitor', action: 'guard-pass', from: apply.from, to: apply.to, reason: `Kept: ${judged.after.runs} runs held the pass rate at ${percent(judged.after.passRate)} against ${percent(judged.before.passRate)}.`, evidence: score(judged.before, judged.after) });
    return settle(dir, apply, { state: 'kept', before: judged.before, after: judged.after }, now);
  }
  if (settings.autoRollback) return rollBack(dir, apply, judged, now, cooldownHours);
  await appendAudit(dir, { actor: 'monitor', action: 'guard-fail', from: apply.from, to: apply.to, reason: `${judged.reason} Automatic rollback is off.`, evidence: score(judged.before, judged.after) });
  return settle(dir, apply, { state: 'regressed', before: judged.before, after: judged.after, reason: judged.reason }, now);
}

/** Compares runs under the current revision with the runs before it was applied, and rolls back on a regression. */
export async function checkApplied(db: SqlDatabase, dir: string, settings: MonitorSettings, options: { now?: number; cooldownHours?: number; agent?: string } = {}): Promise<MonitorVerdict> {
  const now = options.now ?? Date.now();
  const current = currentRevision(dir);
  const apply = lastApply(dir, current);
  if (typeof apply === 'string') return { state: 'idle', reason: apply };
  const stored = readState(dir).monitor;
  if (stored?.revision === current && FINAL.includes(stored.verdict.state)) return stored.verdict;
  const { before, after } = seriesAround(db, apply, settings, options.agent);
  const judged = judgeApplied(before, after, settings);
  if (judged.verdict !== 'wait') return decide(dir, apply, judged, settings, now, options.cooldownHours ?? 24);
  if (now - Date.parse(apply.at) < settings.giveUpDays * DAY_MS) return { state: 'pending', runs: after.length, baselineRuns: before.length };
  await appendAudit(dir, { actor: 'monitor', action: 'unverified', from: apply.from, to: apply.to, reason: `Kept unverified: ${after.length} runs after ${settings.giveUpDays} days, fewer than the ${settings.minRuns} the monitor needs.` });
  return settle(dir, apply, { state: 'kept-unverified', runs: after.length }, now);
}
