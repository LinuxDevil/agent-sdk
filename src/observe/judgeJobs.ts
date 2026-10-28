/**
 * The judge-job queue: LLM-judge evaluator runs the daemon cannot do itself
 * (it holds no provider keys), waiting for Agent Forge to pull them.
 *
 * - A job is `(rule, trace)`; at most one per pair is queued or leased.
 * - Bounded (`maxJobs`, default 500, pending + leased together); past it a
 *   job drops and counts in `stats().dropped`.
 * - `claim` leases jobs from the front for `leaseMs`. The rule is re-read
 *   and the trace built at claim time: a job whose rule was deleted,
 *   disabled or is no longer `judge` (or whose trace is gone) is discarded.
 *   A lease that expires puts its job back at the front of the queue.
 * - `complete` takes a leased, unexpired job's result, writes the score and
 *   forgets the job; anything else is `undefined` (the route's 404).
 * - In memory: pending and leased jobs are lost on a daemon restart.
 */

import { randomUUID } from 'node:crypto';

import type { EvaluatorRuleRow } from './evaluators';
import type { EvaluatorTrace } from './evaluatorTrace';

/** The default bound on judge jobs (pending + leased). */
const JUDGE_JOBS_DEFAULT = 500;

/** A claimed job: what Agent Forge needs to run the judge. */
export interface ClaimedJudgeJob {
  job_id: string;
  rule: EvaluatorRuleRow;
  trace: EvaluatorTrace;
}

/** The judge queue's counters (`queued`/`leased` are current sizes, the rest totals). */
export interface JudgeJobStats {
  queued: number;
  leased: number;
  dropped: number;
  discarded: number;
  scored: number;
}

/** A judge result as the score it becomes. */
export interface JudgeScore {
  rule_name: string;
  trace_id: string;
  agent_id: string | null;
  value: number | null;
  comment: string | null;
}

/** What the queue needs from the worker; `now` and `maxJobs` are test seams. */
export interface JudgeJobsDeps {
  getRule(ruleId: string): EvaluatorRuleRow | undefined;
  loadTrace(traceId: string): EvaluatorTrace | undefined;
  /** Writes the score and returns its id. */
  writeScore(score: JudgeScore): string;
  now?: () => number;
  maxJobs?: number;
}

export interface JudgeJobs {
  /** Whether a job for this pair is queued or leased. */
  has(ruleId: string, traceId: string): boolean;
  /** Queue a job; `false` (and counted) when the queue is full. */
  enqueue(ruleId: string, traceId: string): boolean;
  claim(max: number, leaseMs: number): ClaimedJudgeJob[];
  /** The new score's id, or `undefined` for an unknown, unclaimed or expired job. */
  complete(jobId: string, result: { value: number | null; comment: string | null }): string | undefined;
  stats(): JudgeJobStats;
  clear(): void;
}

interface Job {
  job_id: string;
  rule_id: string;
  trace_id: string;
  enqueued_at: number;
}

interface Lease {
  job: Job;
  until: number;
  rule_name: string;
  agent_id: string | null;
}

const pairKey = (ruleId: string, traceId: string): string => `${ruleId}\u0000${traceId}`;

/** A judge-job queue over the worker's rule, trace and score access. */
export function createJudgeJobs(deps: JudgeJobsDeps): JudgeJobs {
  const now = deps.now ?? Date.now;
  const maxJobs = deps.maxJobs ?? JUDGE_JOBS_DEFAULT;
  const pending: Job[] = [];
  const leased = new Map<string, Lease>();
  const pairs = new Set<string>();
  const counts = { dropped: 0, discarded: 0, scored: 0 };

  const forget = (job: Job): void => {
    pairs.delete(pairKey(job.rule_id, job.trace_id));
  };

  /** Expired leases go back to the front, oldest job first. */
  const reclaim = (): void => {
    const at = now();
    const expired = [...leased.values()].filter((lease) => lease.until <= at).map((lease) => lease.job);
    if (expired.length === 0) return;
    for (const job of expired) leased.delete(job.job_id);
    expired.sort((a, b) => a.enqueued_at - b.enqueued_at);
    pending.unshift(...expired);
  };

  /** The job's live rule and fresh trace, or `undefined` when it can no longer run. */
  const resolve = (job: Job): { rule: EvaluatorRuleRow; trace: EvaluatorTrace } | undefined => {
    const rule = deps.getRule(job.rule_id);
    if (rule === undefined || !rule.enabled || rule.kind !== 'judge') return undefined;
    const trace = deps.loadTrace(job.trace_id);
    return trace === undefined ? undefined : { rule, trace };
  };

  return {
    has: (ruleId, traceId) => pairs.has(pairKey(ruleId, traceId)),
    enqueue(ruleId, traceId) {
      if (pending.length + leased.size >= maxJobs) {
        counts.dropped++;
        return false;
      }
      pending.push({ job_id: randomUUID(), rule_id: ruleId, trace_id: traceId, enqueued_at: now() });
      pairs.add(pairKey(ruleId, traceId));
      return true;
    },
    claim(max, leaseMs) {
      reclaim();
      const claimed: ClaimedJudgeJob[] = [];
      while (claimed.length < max && pending.length > 0) {
        const job = pending.shift() as Job;
        const live = resolve(job);
        if (live === undefined) {
          forget(job);
          counts.discarded++;
          continue;
        }
        leased.set(job.job_id, { job, until: now() + leaseMs, rule_name: live.rule.name, agent_id: live.trace.agent_id });
        claimed.push({ job_id: job.job_id, ...live });
      }
      return claimed;
    },
    complete(jobId, result) {
      reclaim();
      const lease = leased.get(jobId);
      if (lease === undefined) return undefined;
      leased.delete(jobId);
      forget(lease.job);
      const scoreId = deps.writeScore({
        rule_name: lease.rule_name,
        trace_id: lease.job.trace_id,
        agent_id: lease.agent_id,
        ...result,
      });
      counts.scored++;
      return scoreId;
    },
    stats() {
      reclaim();
      return { queued: pending.length, leased: leased.size, ...counts };
    },
    clear() {
      pending.length = 0;
      leased.clear();
      pairs.clear();
    },
  };
}
