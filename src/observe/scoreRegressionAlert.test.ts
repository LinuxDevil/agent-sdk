import { describe, expect, it } from 'vitest';
import type { AlertEvent } from './alerts';
import type { IngestEvent } from './envelope';
import { ingestBatch, openDb } from './store';
import { sweepAgents } from './sweep';

const T0 = 1_700_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);

const heartbeat: IngestEvent = { type: 'agent.heartbeat', data: { agent_id: 'uuid-1', name: 'support', ts: T0 } } as IngestEvent;

function run(i: number, revision: string, value: number): IngestEvent[] {
  const trace = `${revision.slice(0, 1)}${i}`;
  return [
    {
      type: 'observation',
      data: { obs_id: `root-${trace}`, trace_id: trace, agent_id: 'uuid-1', kind: 'span', name: 'invoke_agent support', start: T0 + i * 1000, end: T0 + i * 1000 + 10, status: 'ok', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'stop', 'lousho.harness.revision': revision } },
    } as IngestEvent,
    { type: 'score', data: { score_id: `s-${trace}`, trace_id: trace, name: 'quality', value, source: 'online', agent_id: 'uuid-1', ts: T0 + i * 1000 + 20 } } as IngestEvent,
  ];
}

const runs = (from: number, count: number, revision: string, value: number): IngestEvent[] => Array.from({ length: count }, (_, i) => run(from + i, revision, value)).flat();
const regressions = (alerts: readonly AlertEvent[]) => alerts.filter((alert) => alert.type === 'agent.score_regression');
const NOW = T0 + 10_000_000;

describe('the agent.score_regression alert', () => {
  it('fires when the trajectory gate sees a regression, with the revision and the gate state', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat, ...runs(0, 15, R1, 0.9), ...runs(15, 15, R2, 0.6)]);

    const alerts = regressions(sweepAgents(db, NOW, { scoreRegressionState: new Map() }).alerts);
    expect(alerts).toEqual([
      {
        type: 'agent.score_regression',
        agent_id: 'uuid-1',
        project: null,
        status: expect.any(String) as unknown as string,
        at: NOW,
        details: expect.objectContaining({ name: 'support', revision: R2, peak: expect.closeTo(0.9, 10) as unknown as number, runs: 30 }) as unknown as Record<string, unknown>,
      },
    ]);
    db.close();
  });

  it('the alert fires once per revision', () => {
    const db = openDb(':memory:');
    const state = new Map<string, string>();
    ingestBatch(db, [heartbeat, ...runs(0, 15, R1, 0.9), ...runs(15, 15, R2, 0.6)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: state }).alerts)).toHaveLength(1);
    expect(regressions(sweepAgents(db, NOW + 30_000, { scoreRegressionState: state }).alerts)).toHaveLength(0);
    ingestBatch(db, runs(30, 5, R1, 0.6));
    expect(regressions(sweepAgents(db, NOW + 60_000, { scoreRegressionState: state }).alerts)).toHaveLength(1);
    db.close();
  });

  it('stays quiet on a steady series', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat, ...runs(0, 50, R1, 0.9)]);

    expect(regressions(sweepAgents(db, NOW, { scoreRegressionState: new Map() }).alerts)).toEqual([]);
    db.close();
  });

  it('stays under 50 ms per agent at 10k scores', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [heartbeat, ...runs(0, 10_000, R1, 0.9)]);
    const started = performance.now();
    sweepAgents(db, NOW, { scoreRegressionState: new Map() });
    expect(performance.now() - started).toBeLessThan(50);
    db.close();
  });
});
