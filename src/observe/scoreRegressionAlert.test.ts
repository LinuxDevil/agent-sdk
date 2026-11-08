import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../storage/sqlite/driver';
import type { AlertEvent } from './alerts';
import type { IngestEvent } from './envelope';
import { ingestBatch, openDb } from './store';
import { startStatusSweep, sweepAgents, type ScoreRegressionMemory } from './sweep';

const T0 = 1_700_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);
const NOW = T0 + 10_000_000;

const heartbeat = (agentId = 'uuid-1', name = 'support', ts = NOW): IngestEvent => ({ type: 'agent.heartbeat', data: { agent_id: agentId, name, ts } }) as IngestEvent;

function run(i: number, revision: string | undefined, value: number, agentId = 'uuid-1'): IngestEvent[] {
  const trace = `${agentId}-${revision?.slice(0, 1) ?? 'x'}${i}`;
  return [
    {
      type: 'observation',
      data: {
        obs_id: `root-${trace}`,
        trace_id: trace,
        agent_id: agentId,
        kind: 'span',
        name: 'invoke_agent support',
        start: T0 + i * 1000,
        end: T0 + i * 1000 + 10,
        status: 'ok',
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'stop', ...(revision && { 'lousho.harness.revision': revision }) },
      },
    } as IngestEvent,
    { type: 'score', data: { score_id: `s-${trace}`, trace_id: trace, name: 'quality', value, source: 'online', agent_id: agentId, ts: T0 + i * 1000 + 20 } } as IngestEvent,
  ];
}

const runs = (from: number, count: number, revision: string | undefined, value: number, agentId?: string): IngestEvent[] =>
  Array.from({ length: count }, (_, i) => run(from + i, revision, value, agentId)).flat();
const regressions = (alerts: readonly AlertEvent[]) => alerts.filter((alert) => alert.type === 'agent.score_regression');
const memory = () => new Map<string, ScoreRegressionMemory>();

afterEach(() => {
  vi.restoreAllMocks();
});

type Stream = { db: SqlDatabase; state: Map<string, ScoreRegressionMemory>; next: number; fired: AlertEvent[] };

function stream(): Stream {
  const db = openDb(':memory:');
  ingestBatch(db, [heartbeat()]);
  return { db, state: memory(), next: 0, fired: [] };
}

function feed(target: Stream, count: number, revision: string | undefined, value: number | (() => number)): AlertEvent[] {
  const before = target.fired.length;
  for (let i = 0; i < count; i++) {
    ingestBatch(target.db, run(target.next, revision, typeof value === 'number' ? value : value()));
    target.next += 1;
    target.fired.push(...regressions(sweepAgents(target.db, NOW + target.next, { scoreRegressionState: target.state }).alerts));
  }
  return target.fired.slice(before);
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('the agent.score_regression alert', () => {
  it('fires after three regression judgements in a row, a window of new runs apart, with the gate state', () => {
    const target = stream();
    feed(target, 30, R1, 0.9);
    expect(feed(target, 20, R2, 0.6)).toEqual([]);
    const fired = feed(target, 10, R2, 0.6);

    expect(fired).toEqual([
      {
        type: 'agent.score_regression',
        agent_id: 'uuid-1',
        project: null,
        status: 'healthy',
        at: NOW + 60,
        details: expect.objectContaining({ name: 'support', revision: R2, peak: expect.closeTo(0.9, 10), mean: expect.closeTo(0.6, 10), drop: 0.15, runs: 60 }) as unknown as Record<string, unknown>,
      },
    ]);
    target.db.close();
  });

  it('the alert fires once per revision', () => {
    const target = stream();
    feed(target, 30, R1, 0.9);
    expect(feed(target, 30, R2, 0.6)).toHaveLength(1);
    expect(feed(target, 20, R2, 0.6)).toEqual([]);
    expect(feed(target, 10, R1, 0.3).map((alert) => alert.details.revision)).toEqual([R1]);
    target.db.close();
  });

  it('never repeats a revision while revisions interleave, and names an unstamped run null', () => {
    const target = stream();
    feed(target, 30, undefined, 0.9);
    expect(feed(target, 30, undefined, 0.5).map((alert) => alert.details.revision)).toEqual([null]);
    let flip = 0;
    for (let i = 0; i < 6; i++) feed(target, 7, (flip++ % 2 === 0 ? R1 : R2), 0.5);
    const revisions = target.fired.map((alert) => alert.details.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    target.db.close();
  });

  it('a recovered dip read at once does not fire for the new revision', () => {
    const db = openDb(':memory:');
    const state = memory();
    ingestBatch(db, [heartbeat(), ...runs(0, 15, R1, 0.9), ...runs(15, 10, R1, 0.5), ...runs(25, 15, R2, 0.9)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: state }).alerts)).toEqual([]);
    expect(regressions(sweepAgents(db, NOW + 1, { scoreRegressionState: state }).alerts)).toEqual([]);
    db.close();
  });

  it('a stable pass/fail stream of 1000 runs, judged run by run, raises no alert, and a collapse alerts within 50 runs', () => {
    const target = stream();
    const random = seeded(2026);
    expect(feed(target, 1000, R1, () => (random() < 0.9 ? 1 : 0))).toEqual([]);
    expect(feed(target, 50, R1, () => (random() < 0.1 ? 1 : 0))).toHaveLength(1);
    target.db.close();
  });

  it('catches a sustained fall from 0.9 to 0.5 that fills the last 50 runs', () => {
    const target = stream();
    const random = seeded(31);
    expect(feed(target, 200, R1, () => (random() < 0.9 ? 1 : 0))).toEqual([]);
    expect(feed(target, 100, R2, () => (random() < 0.5 ? 1 : 0)).map((alert) => alert.details.revision)).toEqual([R2]);
    target.db.close();
  });

  it('stays quiet on a steady series, and skips the pass without edge memory', () => {
    const target = stream();
    expect(feed(target, 50, R1, 0.9)).toEqual([]);
    ingestBatch(target.db, runs(50, 30, R1, 0.3));
    expect(regressions(sweepAgents(target.db, NOW).alerts)).toEqual([]);
    target.db.close();
  });

  it('a failing score pass never costs the sweep its down alert', () => {
    const db = openDb(':memory:');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ingestBatch(db, [heartbeat('uuid-1', 'support', T0), ...runs(0, 30, R1, 0.9)]);
    db.exec('DROP TABLE scores');

    const result = sweepAgents(db, NOW, { scoreRegressionState: memory() });
    expect(result.alerts.map((alert) => alert.type)).toEqual(['agent.status']);
    expect(error).toHaveBeenCalledWith('[lousho observe] score regression pass failed:', expect.anything());
    db.close();
  });

  it('the daemon sweep keeps edge memory only when it delivers alerts', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat(), ...runs(0, 15, R1, 0.9), ...runs(15, 15, R2, 0.6)]);
    const delivered: AlertEvent[] = [];
    const sweep = startStatusSweep(db, { intervalMs: 0, now: () => NOW, onAlerts: (alerts) => delivered.push(...alerts) });
    ingestBatch(db, runs(30, 10, R2, 0.6));
    sweep.run(NOW + 1);
    ingestBatch(db, runs(40, 10, R2, 0.6));
    sweep.run(NOW + 2);
    sweep.stop();
    expect(regressions(delivered)).toHaveLength(1);
    expect(regressions(startStatusSweep(db, { intervalMs: 0, now: () => NOW }).run(NOW).alerts)).toEqual([]);
    db.close();
  });

  it('reads each agent through its root index and stays under 50 ms per agent at 10k scores', () => {
    const db = openDb(':memory:');
    const agents = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
    for (const agentId of agents) ingestBatch(db, [heartbeat(agentId, agentId), ...runs(0, 500, R1, 0.9, agentId)]);
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT o.obs_id FROM observations o WHERE o.kind = 'span' AND o.parent_obs_id IS NULL AND o.end IS NOT NULL AND o.start >= 0 AND o.agent_id = 'agent-1' ORDER BY o.start DESC LIMIT 50")
      .all()
      .map((row) => String(row.detail))
      .join('\n');
    expect(plan).toContain('observations_agent_roots');
    expect(plan).not.toContain('TEMP B-TREE');

    const started = performance.now();
    sweepAgents(db, NOW, { scoreRegressionState: memory() });
    expect((performance.now() - started) / agents.length).toBeLessThan(50);
    db.close();
  });
});
