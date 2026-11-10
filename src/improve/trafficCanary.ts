import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { failureReportFromDb } from '../observe/failures';
import { pointOf, significantDrop } from '../observe/continuousScore';
import { finishedRuns, type RevisionRun } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { withFileLock } from '../storage/fileLock';
import { applyProposal, type ApplyResult } from './apply';
import { appendAudit, cleanActor, readAudit, type AuditEntry } from './audit';
import type { CanaryReplayResult } from './canary';
import { CANARY_FILE, DEFAULT_MAX_ALWAYS_ON, isPaused, MAX_CANARY_SESSIONS, MAX_CANARY_SHARE, readCanary, SESSIONS_FILE, type TrafficCanary } from './canaryArm';
import { formatImproveResult } from './format';
import { validateHarness } from './harness';
import { savePending, type PendingProposal } from './pending';
import { judgeApplied } from './monitor';
import { harnessHash, readAgentHarness } from './revisions';
import type { ImproveSettings } from './settings';
import type { Harness, ImproveResult } from './types';

export { readCanary, routesToCandidate } from './canaryArm';
export type { TrafficCanary } from './canaryArm';

/** A gated proposal to trial on live traffic, and the harness it was made against. */
export interface StartCanaryInput {
  /** The gated result; only a `proposal` with a harness can be trialled. */
  result: ImproveResult;
  /** The harness the proposal was made against; the directory must still hold it. */
  base: Harness;
  /** The replay canary's verdict, when the cases could be replayed; a failed one refuses the start. */
  replay?: Pick<CanaryReplayResult, 'passed' | 'reason'>;
  /** The self-healing cycle that made the proposal. */
  cycle?: string;
  /** The agent id or name runs are filtered by, when several agents share a revision. */
  agent?: string;
  /** The instructions length limit the proposal was gated with (default 8000). */
  maxAlwaysOnChars?: number;
  /** The person who approved the proposal; required in manual mode, where the promote then applies in their name. */
  approvedBy?: string;
}

/** What the forward trial says about the running canary. */
export interface CanaryVerdict {
  /** `none` with no canary, `pending` until enough sessions, else `promote` or `retire`. */
  state: 'none' | 'pending' | 'promote' | 'retire';
  /** Candidate sessions counted so far; a run without a session id counts as its own session. */
  sessions: number;
  /** Candidate sessions with a run that failed or scored low. */
  flagged: number;
  /** The base's flagged rate the trial is compared against. */
  p0: number;
  /** Failure classes seen under the candidate but not in the base's last 20 runs. */
  newClasses: string[];
  /** Why, in a sentence. */
  reason: string;
}

/** What settling a canary did. */
export interface CanarySettlement {
  /** The verdict it acted on. */
  verdict: CanaryVerdict;
  /** `applied` (auto mode) or `queued` (manual mode) on a promote; `retired` when the canary ended without one, a refused promote included. */
  outcome: 'none' | 'pending' | 'applied' | 'queued' | 'retired';
  /** The apply's revisions, when applied. */
  applied?: ApplyResult;
  /** The pending proposal, when queued. */
  queued?: PendingProposal;
  /** Why, in a sentence. */
  reason: string;
}

const PROMOTE_MARGIN = 0.05;
const HISTORY = 20;
const HOUR = 3_600_000;
const EPSILON = 1e-9;
const TRIAL_LIMIT = 5000;
const SESSION_OF = "SELECT trace_id, CASE WHEN json_valid(attrs) THEN json_extract(attrs, '$.\"gen_ai.conversation.id\"') END AS session FROM observations WHERE kind = 'span' AND parent_obs_id IS NULL AND trace_id IN (SELECT value FROM json_each(?))";

function refuse(message: string, field = 'canary'): never {
  throw new ConfigurationError(`startCanary: ${message}`, field);
}

async function withCanaryLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const lousho = path.join(dir, '.lousho');
  if (lstatSync(lousho, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConfigurationError(`${lousho} is a symlink; the canary, its lock and the audit log must live inside the agent directory.`, 'canary');
  mkdirSync(lousho, { recursive: true });
  return withFileLock(path.join(dir, '.lousho', 'canary.lock'), task);
}

export function canaryRunning(dir: string): boolean {
  return statSync(path.join(dir, CANARY_FILE), { throwIfNoEntry: false }) !== undefined;
}

function writeCanary(dir: string, canary: TrafficCanary): void {
  const file = path.join(dir, CANARY_FILE);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(canary, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function cooldownUntil(dir: string, hours: number): number {
  const rolledBack = readAudit(dir).filter((entry) => entry.action === 'rollback').map((entry) => Date.parse(entry.at) + hours * HOUR);
  let state = 0;
  try {
    const value = (JSON.parse(readFileSync(path.join(dir, '.lousho', 'state.json'), 'utf8')) as { cooldownUntil?: unknown }).cooldownUntil;
    state = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;
  } catch {
    state = 0;
  }
  return Math.max(0, state, ...rolledBack);
}

function flaggedRate(runs: readonly RevisionRun[]): number {
  return runs.length === 0 ? 1 : runs.filter((run) => run.failed).length / runs.length;
}

function checkedTraffic(dir: string, settings: ImproveSettings): { share: number; sessions: number } {
  const traffic = settings.canary.traffic;
  if (!traffic) refuse('improve.json does not opt in to the traffic canary; set canary.traffic to turn it on.', 'canary.traffic');
  const shareOk = traffic.share > 0 && traffic.share <= MAX_CANARY_SHARE;
  const sessionsOk = Number.isInteger(traffic.sessions) && traffic.sessions > 0 && traffic.sessions <= MAX_CANARY_SESSIONS;
  if (!shareOk || !sessionsOk) refuse(`canary.traffic must keep share ≤ ${MAX_CANARY_SHARE} and sessions ≤ ${MAX_CANARY_SESSIONS}.`, 'canary.traffic');
  if (isPaused(dir, settings, process.env)) refuse('the self-healing loop is paused for this directory.');
  return traffic;
}

function approverOf(input: StartCanaryInput, settings: ImproveSettings): string | undefined {
  const approvedBy = input.approvedBy?.trim();
  if (input.approvedBy !== undefined && !approvedBy) refuse('approvedBy is empty; pass the name of the person who approved the proposal.', 'approvedBy');
  if (settings.approval === 'manual' && !approvedBy) refuse('in manual mode the traffic canary starts only when a person approves the proposal (lousho improve approve).', 'approvedBy');
  return approvedBy;
}

function checkedCandidate(dir: string, input: StartCanaryInput, settings: ImproveSettings, now: number): Harness {
  const { result, base } = input;
  if (result.outcome !== 'proposal' || !result.harness) refuse(`only a proposal with a harness can be trialled; this result is '${result.outcome}'.`, 'result');
  if (input.replay && !input.replay.passed) refuse(`the replay canary failed: ${input.replay.reason}`, 'replay');
  if (statSync(path.join(dir, CANARY_FILE), { throwIfNoEntry: false })) refuse('a traffic canary is already running for this agent.');
  if (cooldownUntil(dir, settings.cooldownHours) > now) refuse('a rollback cooldown is active; no canary starts until it ends.', 'cooldown');
  if (harnessHash(readAgentHarness(dir)) !== harnessHash(base)) refuse('the proposal is stale: the agent directory changed after it was made.', 'base');
  if (harnessHash(result.harness) === harnessHash(base)) refuse('the proposal changes nothing.', 'result');
  const failedChecks = input.approvedBy === undefined ? (result.failedChecks ?? []) : [];
  const errors = validateHarness(result.harness, base, { maxAlwaysOnChars: input.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON, failedChecks });
  if (errors.length > 0) refuse(`the candidate fails validation: ${errors.join(' ')}`, 'result');
  return result.harness;
}

function newCanary(input: StartCanaryInput, traffic: { share: number; sessions: number }, candidate: Harness, p0: number, now: number): TrafficCanary {
  const { cycle, agent, maxAlwaysOnChars, approvedBy } = input;
  const optional = { ...(cycle && { cycle }), ...(agent && { agent }), ...(maxAlwaysOnChars !== undefined && { maxAlwaysOnChars }), ...(approvedBy && { approvedBy }) };
  return { candidate, revision: harnessHash(candidate), base: input.base, baseRevision: harnessHash(input.base), share: traffic.share, sessions: traffic.sessions, startedAt: new Date(now).toISOString(), p0, result: input.result, ...optional };
}

async function startLocked(db: SqlDatabase, dir: string, input: StartCanaryInput, settings: ImproveSettings, now: number): Promise<TrafficCanary> {
  const traffic = checkedTraffic(dir, settings);
  const approvedBy = approverOf(input, settings);
  const candidate = checkedCandidate(dir, { ...input, ...(approvedBy && { approvedBy }) }, settings, now);
  const history = finishedRuns(db, { revision: harnessHash(input.base), ...(input.agent && { agent: input.agent }), endedBefore: now, byEnd: true, limit: HISTORY });
  const canary = newCanary({ ...input, ...(approvedBy && { approvedBy }) }, traffic, candidate, flaggedRate(history), now);
  rmSync(path.join(dir, SESSIONS_FILE), { force: true });
  await appendAudit(dir, { actor: approvedBy ? cleanActor(`person:${approvedBy}`) : 'canary', action: 'canary-start', from: canary.baseRevision, to: canary.revision, ...(canary.cycle && { cycle: canary.cycle }), reason: `Serving the candidate to ${Math.round(canary.share * 100)}% of new sessions for ${canary.sessions} sessions (base flagged rate ${canary.p0.toFixed(2)}).` });
  writeCanary(dir, canary);
  return canary;
}

/** Starts the opt-in live traffic canary for a gated proposal: writes .lousho/canary.json and audits canary-start; refuses unless improve.json sets canary.traffic. */
export async function startCanary(db: SqlDatabase, dir: string, input: StartCanaryInput, settings: ImproveSettings, now: number = Date.now()): Promise<TrafficCanary> {
  return withCanaryLock(dir, () => startLocked(db, dir, input, settings, now));
}

function classesOf(db: SqlDatabase, runs: readonly RevisionRun[]): Set<string> {
  if (runs.length === 0) return new Set();
  const since = Math.min(...runs.map((run) => run.startedAt));
  return new Set(failureReportFromDb(db, { since, traceIds: runs.map((run) => run.traceId) }).groups.map((group) => group.failureClass));
}

function closedReason(dir: string, canary: TrafficCanary, settings: ImproveSettings): string | undefined {
  if (isPaused(dir, settings, process.env)) return 'the self-healing loop was paused.';
  if (!settings.canary.traffic) return 'improve.json no longer opts in to the traffic canary.';
  let current: string;
  try {
    current = harnessHash(readAgentHarness(dir));
  } catch (error) {
    return `the agent directory can no longer be read (${(error as Error).message}).`;
  }
  return current === canary.baseRevision ? undefined : 'the agent directory changed since the canary started.';
}

function firstSessions(db: SqlDatabase, runs: readonly RevisionRun[], limit: number): RevisionRun[][] {
  const sessionOf = new Map(db.prepare(SESSION_OF).all(JSON.stringify(runs.map((run) => run.traceId))).map((row) => [String(row.trace_id), row.session === null || row.session === undefined ? undefined : String(row.session)]));
  const sessions = new Map<string, RevisionRun[]>();
  for (const run of runs) {
    const key = sessionOf.get(run.traceId) ?? `trace:${run.traceId}`;
    const group = sessions.get(key);
    if (group) group.push(run);
    else if (sessions.size < limit) sessions.set(key, [run]);
  }
  return [...sessions.values()];
}

interface Trial {
  counts: Omit<CanaryVerdict, 'state' | 'reason'>;
  base: RevisionRun[];
  sessions: RevisionRun[][];
}

function trial(db: SqlDatabase, canary: TrafficCanary): Trial {
  const agent = canary.agent ? { agent: canary.agent } : {};
  const runs = finishedRuns(db, { revision: canary.revision, ...agent, since: Date.parse(canary.startedAt), byEnd: true, limit: TRIAL_LIMIT }).reverse();
  const sessions = firstSessions(db, runs, canary.sessions);
  const base = finishedRuns(db, { revision: canary.baseRevision, ...agent, byEnd: true, limit: HISTORY }).reverse();
  const baseClasses = classesOf(db, base);
  const newClasses = [...classesOf(db, sessions.flat())].filter((name) => !baseClasses.has(name)).sort();
  const counts = { sessions: sessions.length, flagged: sessions.filter((group) => group.some((run) => run.failed)).length, p0: canary.p0, newClasses };
  return { counts, base, sessions };
}

function regressedAgainstBase(found: Trial, monitor: ImproveSettings['monitor']): string | undefined {
  const basePasses = found.base.map((run) => (run.failed ? 0 : 1));
  const sessionPasses = found.sessions.map((group) => (group.some((run) => run.failed) ? 0 : 1));
  if (significantDrop(basePasses, sessionPasses)) return 'The candidate sessions pass significantly less often than the base runs.';
  const judged = judgeApplied(found.base.map(pointOf), found.sessions.flat().map(pointOf), monitor);
  return judged.verdict === 'regressed' ? judged.reason : undefined;
}

function decide(counts: Omit<CanaryVerdict, 'state' | 'reason'>, canary: TrafficCanary, giveUpDays: number, now: number): CanaryVerdict {
  const { sessions, flagged, p0, newClasses } = counts;
  const bar = p0 - PROMOTE_MARGIN;
  if (newClasses.length > 0) return { ...counts, state: 'retire', reason: `A failure class the base did not have appeared under the candidate: ${newClasses.join(', ')}.` };
  if (flagged > 0 && flagged / canary.sessions > bar + EPSILON) return { ...counts, state: 'retire', reason: `${flagged} of ${canary.sessions} trial sessions flagged already rules out beating the base rate ${p0.toFixed(2)} by ${PROMOTE_MARGIN}.` };
  if (sessions < canary.sessions) {
    if (now - Date.parse(canary.startedAt) > giveUpDays * 24 * HOUR) return { ...counts, state: 'retire', reason: `too few sessions: ${sessions} of ${canary.sessions} after ${giveUpDays} days.` };
    return { ...counts, state: 'pending', reason: `${sessions} of ${canary.sessions} trial sessions so far.` };
  }
  return { ...counts, state: 'promote', reason: `${flagged} of ${sessions} trial sessions flagged against a base rate of ${p0.toFixed(2)}, and no new failure class.` };
}

function verdictOf(db: SqlDatabase, dir: string, canary: TrafficCanary, settings: ImproveSettings, now: number): CanaryVerdict {
  const found = trial(db, canary);
  const closed = closedReason(dir, canary, settings) ?? regressedAgainstBase(found, settings.monitor);
  if (closed) return { ...found.counts, state: 'retire', reason: closed };
  return decide(found.counts, canary, settings.monitor.giveUpDays, now);
}

const NONE: CanaryVerdict = { state: 'none', sessions: 0, flagged: 0, p0: 1, newClasses: [], reason: 'No traffic canary is running.' };

function invalidVerdict(error: unknown): CanaryVerdict {
  return { ...NONE, state: 'retire', reason: error instanceof Error ? error.message : String(error) };
}

/** The forward trial's verdict on the running canary, without changing anything: promote at a flagged rate of 0 or at most p0 − 0.05 with no new failure class, retire early once that is ruled out. */
export function canaryVerdict(db: SqlDatabase, dir: string, settings: ImproveSettings, now: number = Date.now()): CanaryVerdict {
  let canary: TrafficCanary | undefined;
  try {
    canary = readCanary(dir);
  } catch (error) {
    return invalidVerdict(error);
  }
  return canary ? verdictOf(db, dir, canary, settings, now) : NONE;
}

async function endCanary(dir: string, canary: TrafficCanary | undefined, actor: AuditEntry['actor'], reason: string): Promise<void> {
  rmSync(path.join(dir, CANARY_FILE), { force: true });
  rmSync(path.join(dir, SESSIONS_FILE), { force: true });
  await appendAudit(dir, { actor, action: 'canary-end', ...(canary && { from: canary.baseRevision, to: canary.revision, ...(canary.cycle && { cycle: canary.cycle }) }), reason });
}

async function promote(dir: string, canary: TrafficCanary, verdict: CanaryVerdict, settings: ImproveSettings): Promise<CanarySettlement> {
  const input = { result: canary.result, base: canary.base, ...(canary.cycle && { cycle: canary.cycle }), ...(canary.maxAlwaysOnChars !== undefined && { maxAlwaysOnChars: canary.maxAlwaysOnChars }) };
  try {
    if (canary.approvedBy) {
      const applied = await applyProposal(dir, input, { mode: 'manual', approvedBy: canary.approvedBy });
      await endCanary(dir, canary, 'canary', `Promoted and applied as approved by ${canary.approvedBy}: ${verdict.reason}`);
      return { verdict, outcome: 'applied', applied, reason: verdict.reason };
    }
    if (settings.approval === 'manual') {
      const queued = await savePending(dir, { ...input, card: formatImproveResult(canary.result) });
      await endCanary(dir, canary, 'canary', `Promoted to a pending proposal ${queued.id}: ${verdict.reason}`);
      return { verdict, outcome: 'queued', queued, reason: verdict.reason };
    }
    const applied = await applyProposal(dir, input, { mode: 'auto', by: 'canary' });
    await endCanary(dir, canary, 'canary', `Promoted and applied: ${verdict.reason}`);
    return { verdict, outcome: 'applied', applied, reason: verdict.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endCanary(dir, canary, 'canary', `Retired: the promote was refused. ${message}`);
    if (!(error instanceof ConfigurationError)) throw error;
    return { verdict: { ...verdict, state: 'retire', reason: message }, outcome: 'retired', reason: message };
  }
}

async function settleLocked(db: SqlDatabase, dir: string, settings: ImproveSettings, now: number): Promise<CanarySettlement> {
  let canary: TrafficCanary | undefined;
  try {
    canary = readCanary(dir);
  } catch (error) {
    const verdict = invalidVerdict(error);
    await endCanary(dir, undefined, 'canary', `Retired an invalid canary: ${verdict.reason}`);
    return { verdict, outcome: 'retired', reason: verdict.reason };
  }
  if (!canary) return { verdict: NONE, outcome: 'none', reason: NONE.reason };
  const verdict = verdictOf(db, dir, canary, settings, now);
  if (verdict.state === 'pending') return { verdict, outcome: 'pending', reason: verdict.reason };
  if (verdict.state === 'retire') {
    await endCanary(dir, canary, 'canary', `Retired: ${verdict.reason}`);
    return { verdict, outcome: 'retired', reason: verdict.reason };
  }
  return promote(dir, canary, verdict, settings);
}

/** Acts on the canary's verdict: on promote, applies as the canary (auto) or queues a pending proposal (manual); on retire, ends it. Either way canary.json is removed and canary-end audited. */
export async function settleCanary(db: SqlDatabase, dir: string, settings: ImproveSettings, now: number = Date.now()): Promise<CanarySettlement> {
  return withCanaryLock(dir, () => settleLocked(db, dir, settings, now));
}

function readableCanary(dir: string): TrafficCanary | undefined {
  try {
    return readCanary(dir);
  } catch {
    return undefined;
  }
}

async function stopLocked(dir: string, actor: AuditEntry['actor'], reason: string): Promise<boolean> {
  if (!statSync(path.join(dir, CANARY_FILE), { throwIfNoEntry: false })) return false;
  await endCanary(dir, readableCanary(dir), actor, `Stopped: ${reason}`);
  return true;
}

/** Ends a running canary without a verdict, as the kill switch or a person does; returns false when none was running. */
export async function stopCanary(dir: string, by: { actor: AuditEntry['actor']; reason: string }): Promise<boolean> {
  const actor = cleanActor(by.actor);
  return withCanaryLock(dir, () => stopLocked(dir, actor, by.reason));
}
