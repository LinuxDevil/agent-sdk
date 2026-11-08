import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('the agent.score_regression alert', () => {
  it('fires when the trajectory gate sees a regression, with the revision and the gate state', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat(), ...runs(0, 15, R1, 0.9), ...runs(15, 15, R2, 0.6)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: memory() }).alerts)).toEqual([
      {
        type: 'agent.score_regression',
        agent_id: 'uuid-1',
        project: null,
        status: 'healthy',
        at: NOW,
        details: expect.objectContaining({ name: 'support', revision: R2, peak: expect.closeTo(0.9, 10), mean: expect.closeTo(0.6, 10), drop: 0.15, runs: 30 }) as unknown as Record<string, unknown>,
      },
    ]);
    db.close();
  });

  it('the alert fires once per revision', () => {
    const db = openDb(':memory:');
    const state = memory();
    ingestBatch(db, [heartbeat(), ...runs(0, 15, R1, 0.9), ...runs(15, 15, R2, 0.6)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: state }).alerts)).toHaveLength(1);
    expect(regressions(sweepAgents(db, NOW + 30_000, { scoreRegressionState: state }).alerts)).toHaveLength(0);
    ingestBatch(db, runs(30, 3, R2, 0.6));
    expect(regressions(sweepAgents(db, NOW + 60_000, { scoreRegressionState: state }).alerts)).toHaveLength(0);
    ingestBatch(db, runs(33, 3, R1, 0.6));
    expect(regressions(sweepAgents(db, NOW + 90_000, { scoreRegressionState: state }).alerts).map((alert) => alert.details.revision)).toEqual([R1]);
    db.close();
  });

  it('does not repeat while revisions interleave, and names an unstamped run null', () => {
    const db = openDb(':memory:');
    const state = memory();
    ingestBatch(db, [heartbeat(), ...runs(0, 20, undefined, 0.9), ...runs(20, 10, undefined, 0.5)]);
    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: state }).alerts).map((alert) => alert.details.revision)).toEqual([null]);

    const fired: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      ingestBatch(db, run(30 + i, i % 2 === 0 ? R1 : R2, 0.5));
      fired.push(...regressions(sweepAgents(db, NOW + i, { scoreRegressionState: state }).alerts).map((alert) => alert.details.revision));
    }
    expect(fired).toEqual([R1, R2]);
    db.close();
  });

  it('a recovered dip does not fire when a new revision starts', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat(), ...runs(0, 15, R1, 0.9), ...runs(15, 10, R1, 0.5), ...runs(25, 15, R2, 0.9)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: memory() }).alerts)).toEqual([]);
    db.close();
  });

  it('stays quiet on a steady series, and skips the pass without edge memory', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat(), ...runs(0, 50, R1, 0.9)]);
    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: memory() }).alerts)).toEqual([]);

    ingestBatch(db, runs(50, 10, R1, 0.3));
    expect(regressions(sweepAgents(db, NOW).alerts)).toEqual([]);
    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: memory() }).alerts)).toHaveLength(1);
    db.close();
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
    sweep.run(NOW + 1);
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
