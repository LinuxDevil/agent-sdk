import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { ingestBatch, openDb, runsByRevision } from './store';

const T0 = 1_790_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);

function root(trace: string, revision: string | undefined, at: number, over: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}): IngestEvent {
  return {
    type: 'observation',
    data: {
      obs_id: `root-${trace}`,
      trace_id: trace,
      agent_id: 'support',
      kind: 'span',
      name: 'invoke_agent support',
      start: at,
      end: at + 10,
      status: 'ok',
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', 'lousho.run.finish_reason': 'stop', ...(revision && { 'lousho.harness.revision': revision }), ...attrs },
      ...over,
    },
  } as IngestEvent;
}

const failedTool = (trace: string, at: number): IngestEvent =>
  ({
    type: 'observation',
    data: { obs_id: `tool-${trace}`, trace_id: trace, parent_obs_id: `root-${trace}`, agent_id: 'support', kind: 'tool', name: 'execute_tool lookup', start: at + 1, end: at + 2, status: 'error', attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', error: 'boom' } },
  }) as IngestEvent;

const score = (id: string, trace: string, value: number | undefined, source = 'online'): IngestEvent =>
  ({ type: 'score', data: { score_id: id, trace_id: trace, name: 'quality', ...(value !== undefined && { value }), source, agent_id: 'support', ts: T0 } }) as IngestEvent;

describe('runsByRevision', () => {
  it("returns only that revision's runs, newest first", () => {
    const db = openDb(':memory:');
    ingestBatch(db, [root('t1', R1, T0), root('t2', R2, T0 + 1000), root('t3', R1, T0 + 2000), root('t4', undefined, T0 + 3000)]);

    expect(runsByRevision(db, { revision: R1, limit: 10 }).map((run) => run.traceId)).toEqual(['t3', 't1']);
    expect(runsByRevision(db, { revision: R2, limit: 10 })).toEqual([{ traceId: 't2', startedAt: T0 + 1000, failed: false }]);
    db.close();
  });

  it('marks failed runs and averages finished online scores', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [root('t1', R1, T0), failedTool('t1', T0), root('t2', R1, T0 + 1000), score('s1', 't2', 0.5), score('s2', 't2', 1), score('s3', 't2', undefined), score('s4', 't2', 0, 'human'), root('t3', R1, T0 + 2000, {}, { 'lousho.run.finish_reason': 'max-steps' })]);

    const runs = runsByRevision(db, { revision: R1, limit: 10 });
    expect(runs).toEqual([
      { traceId: 't3', startedAt: T0 + 2000, failed: true },
      { traceId: 't2', startedAt: T0 + 1000, failed: true, score: 0.75 },
      { traceId: 't1', startedAt: T0, failed: true },
    ]);
    db.close();
  });

  it('filters by agent, time and limit, and skips runs still in flight', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [root('t1', R1, T0), root('t2', R1, T0 + 1000, { agent_id: 'billing' }), root('t3', R1, T0 + 2000), root('t4', R1, T0 + 3000), root('t5', R1, T0 + 4000, { end: undefined, status: undefined })]);

    expect(runsByRevision(db, { revision: R1, agent: 'support', limit: 10 }).map((run) => run.traceId)).toEqual(['t4', 't3', 't1']);
    expect(runsByRevision(db, { revision: R1, since: T0 + 1500, limit: 10 }).map((run) => run.traceId)).toEqual(['t4', 't3']);
    expect(runsByRevision(db, { revision: R1, limit: 2 }).map((run) => run.traceId)).toEqual(['t4', 't3']);
    db.close();
  });

  it('answers within 200 ms over 10k runs without an index', () => {
    const db = openDb(':memory:');
    ingestBatch(db, Array.from({ length: 10_000 }, (_, i) => root(`t${i}`, i % 2 === 0 ? R1 : R2, T0 + i)));
    const started = performance.now();
    const runs = runsByRevision(db, { revision: R1, limit: 40 });
    expect(performance.now() - started).toBeLessThan(200);
    expect(runs).toHaveLength(40);
    db.close();
  });

  it('matches an agent by the name its heartbeat registered', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [{ type: 'agent.heartbeat', data: { agent_id: 'uuid-1', name: 'doc-qa', ts: T0 } } as IngestEvent, root('t1', R1, T0, { agent_id: 'uuid-1' })]);

    expect(runsByRevision(db, { revision: R1, agent: 'doc-qa', limit: 10 }).map((run) => run.traceId)).toEqual(['t1']);
    db.close();
  });
});
