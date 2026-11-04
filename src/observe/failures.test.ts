import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { failureReportFromDb, failureReportFromTraces, formatFailureReport, groupFailures, type FailureSample } from './failures';
import { ingestBatch, interruptAgentWork, openDb } from './store';

const T0 = 1_790_000_000_000;

const sample = (over: Partial<FailureSample> = {}): FailureSample => ({
  agent: 'support',
  source: 'lookup',
  operation: 'execute_tool',
  error: 'request timed out after 100ms',
  traceId: 't1',
  at: T0,
  ...over,
});

function tool(id: string, trace: string, over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}, attrs: Record<string, unknown> = {}): IngestEvent {
  return {
    type: 'observation',
    data: {
      obs_id: id,
      trace_id: trace,
      agent_id: 'support',
      kind: 'tool',
      name: 'execute_tool lookup',
      start: T0,
      end: T0 + 5,
      attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', ...attrs },
      ...over,
    },
  };
}

const failed = (id: string, trace: string, error: string, attrs: Record<string, unknown> = {}, over = {}) =>
  tool(id, trace, { status: 'error', ...over }, { error, ...attrs });

describe('groupFailures', () => {
  it('groups by agent, source and signature, treating numbers and ids as the same', () => {
    const groups = groupFailures([
      sample({ traceId: 't1', error: 'request timed out after 100ms' }),
      sample({ traceId: 't2', error: 'request timed out after 250ms', at: T0 + 10 }),
      sample({ traceId: 't3', error: 'HTTP 403 Forbidden' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ agent: 'support', source: 'lookup', count: 2, traces: 2, recurring: true, failureClass: 'timeout', firstSeen: T0, lastSeen: T0 + 10 });
    expect(groups[1]).toMatchObject({ count: 1, traces: 1, recurring: false, failureClass: 'permission' });
  });

  it('counts one trace once for recurrence, and ranks by traces before count', () => {
    const groups = groupFailures([
      sample({ traceId: 't1', error: 'loop' }),
      sample({ traceId: 't1', error: 'loop' }),
      sample({ traceId: 't1', error: 'loop' }),
      sample({ traceId: 't2', error: 'other' }),
      sample({ traceId: 't3', error: 'other' }),
    ]);
    expect(groups.map((g) => [g.example, g.count, g.traces, g.recurring])).toEqual([
      ['other', 2, 2, true],
      ['loop', 3, 1, false],
    ]);
  });

  it('separates agents and sources, and caps the linked trace ids', () => {
    const many = Array.from({ length: 8 }, (_, i) => sample({ traceId: `t${i}` }));
    const groups = groupFailures([...many, sample({ agent: 'billing' }), sample({ source: 'search' })]);
    expect(groups).toHaveLength(3);
    expect(groups[0].traceIds).toHaveLength(5);
  });

  it('labels the guard own denials, and counts hints', () => {
    const [denied] = groupFailures([sample({ error: "hook 'progress-guard' denied: [progress-guard] 'lookup' was called 3 times" })]);
    expect(denied.failureClass).toBe('guard-denied');
    const [stopped] = groupFailures([sample({ error: 'The run was stopped.\n[LOUSHO_RUN_NO_PROGRESS] Read the events.' })]);
    expect(stopped.failureClass).toBe('guard-denied');
    const [hinted] = groupFailures([sample({ hinted: true }), sample({ traceId: 't2' })]);
    expect(hinted.hints).toBe(1);
  });
});

describe('failureReportFromDb', () => {
  it('reads tool and model failures, skipping the agent span that repeats them, and reports what it scanned', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      failed('o1', 't1', 'request timed out'),
      failed('o2', 't2', 'request timed out'),
      failed('o3', 't3', 'overloaded', {}, { kind: 'generation', name: 'chat gpt', attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt', error: 'overloaded' } }),
      tool('o4', 't1', { status: 'ok' }),
      { type: 'observation', data: { obs_id: 'r1', trace_id: 't1', agent_id: 'support', kind: 'span', name: 'invoke_agent support', start: T0, end: T0 + 9, status: 'error', attrs: { 'gen_ai.operation.name': 'invoke_agent', error: 'request timed out' } } },
    ]);
    const report = failureReportFromDb(db, {});
    expect(report.scanned).toEqual({ traces: 3, spans: 4, failed: 3, noAnswer: 0, interrupted: 0, lowScores: 0 });
    expect(report.groups.map((g) => [g.source, g.operation, g.count])).toEqual([
      ['lookup', 'execute_tool', 2],
      ['chat gpt', 'chat', 1],
    ]);
    db.close();
  });

  it('filters by agent and time', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'old'), failed('o2', 't2', 'new', {}, { start: T0 + 1000 }), failed('o3', 't3', 'other agent', {}, { agent_id: 'billing', start: T0 + 1000 })]);
    expect(failureReportFromDb(db, { since: T0 + 500, agent: 'support' }).groups.map((g) => g.example)).toEqual(['new']);
    db.close();
  });

  it('counts a hook replacement as a hint, whichever status the span has', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'request timed out', { 'lousho.tool.replaced_by_hook': 'progress-guard' })]);
    expect(failureReportFromDb(db, {}).groups[0].hints).toBe(1);
    db.close();
  });

  it('names the agent from the span, falling back to its id', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'boom', { 'gen_ai.agent.name': 'support-bot' }, { agent_id: 'uuid-1' }), failed('o2', 't2', 'bang', {}, { agent_id: 'uuid-2' })]);
    expect(failureReportFromDb(db, {}).groups.map((g) => g.agent).sort()).toEqual(['support-bot', 'uuid-2']);
    db.close();
  });

  it('names an agent from the registry when the span has no agent name', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      { type: 'agent.heartbeat', ts: T0, data: { agent_id: 'uuid-1', name: 'doc-qa' } } as IngestEvent,
      failed('o1', 't1', 'boom', {}, { agent_id: 'uuid-1' }),
    ]);
    expect(failureReportFromDb(db, {}).groups[0].agent).toBe('doc-qa');
    db.close();
  });

  it('lists runs that ended without an answer, even when no call failed', () => {
    const db = openDb(':memory:');
    const root = (id: string, reason: string): IngestEvent => ({
      type: 'observation',
      data: { obs_id: id, trace_id: id, agent_id: 'a', kind: 'span', name: 'invoke_agent doc-qa', start: T0, end: T0 + 9, status: 'ok', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'doc-qa', 'lousho.run.finish_reason': reason } },
    });
    ingestBatch(db, [root('r1', 'max-steps'), root('r2', 'max-steps'), root('r3', 'budget-exceeded'), root('r4', 'stop')]);
    const report = failureReportFromDb(db, {});
    expect(report.scanned.noAnswer).toBe(3);
    expect(report.groups[0]).toMatchObject({ agent: 'doc-qa', source: 'run', operation: 'invoke_agent', failureClass: 'no-answer', example: 'The run ended with max-steps and no answer', traces: 2, recurring: true });
    db.close();
  });

  it('lists low scores, so a run with a wrong answer and no error still shows up', () => {
    const db = openDb(':memory:');
    const score = (id: string, trace: string, value: number | undefined): IngestEvent =>
      ({ type: 'score', data: { score_id: id, trace_id: trace, name: 'accuracy', ...(value !== undefined && { value }), source: 'human', agent_id: 'uuid-1', ts: T0 } }) as IngestEvent;
    ingestBatch(db, [{ type: 'agent.heartbeat', data: { agent_id: 'uuid-1', name: 'doc-qa', ts: T0 } } as IngestEvent, score('s1', 't1', 0), score('s2', 't2', 0.25), score('s3', 't3', 1), score('s4', 't4', undefined)]);
    const report = failureReportFromDb(db, {});
    expect(report.scanned.lowScores).toBe(2);
    expect(report.groups[0]).toMatchObject({ agent: 'doc-qa', source: 'score accuracy', operation: 'score', failureClass: 'low-score', traces: 2, recurring: true });
    expect(failureReportFromDb(db, { minScore: 0.1 }).scanned.lowScores).toBe(1);
    db.close();
  });

  it('never counts a missing score as a low one, and honours the time filter', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [{ type: 'score', data: { score_id: 's1', trace_id: 't1', name: 'accuracy', value: 0, source: 'human', ts: T0 } } as IngestEvent]);
    expect(failureReportFromDb(db, { since: T0 + 1 }).scanned.lowScores).toBe(0);
    db.close();
  });

  it('lists runs whose process died, so they are not read as the agent stopping', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      { type: 'observation', data: { obs_id: 'r1', trace_id: 't1', agent_id: 'a', kind: 'span', name: 'invoke_agent doc-qa', start: T0, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'doc-qa' } } },
    ]);
    interruptAgentWork(db, 'a', T0 + 100);
    const report = failureReportFromDb(db, {});
    expect(report.scanned.interrupted).toBe(1);
    expect(report.groups[0]).toMatchObject({ agent: 'doc-qa', source: 'run', failureClass: 'interrupted' });
    db.close();
  });

  it('survives attrs that are not valid JSON objects', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'boom')]);
    db.prepare("UPDATE observations SET attrs = 'not json' WHERE obs_id = 'o1'").run();
    expect(failureReportFromDb(db, {}).groups).toEqual([]);
    db.close();
  });
});

describe('classes', () => {
  it('names rate limits', () => {
    expect(groupFailures([sample({ error: 'Rate limit exceeded: free-models-per-min.' })])[0].failureClass).toBe('rate-limit');
    expect(groupFailures([sample({ error: 'HTTP 429' })])[0].failureClass).toBe('rate-limit');
  });
});

describe('failureReportFromTraces', () => {
  it('lists no-answer runs from trace files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-failures-'));
    const day = path.join(dir, '2026-11-01');
    fs.mkdirSync(day);
    const line = { v: 1, traceId: 'abc', id: 'abc', name: 'invoke_agent doc-qa', startTime: T0, endTime: T0 + 1, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'doc-qa', 'lousho.run.finish_reason': 'max-steps' } };
    fs.writeFileSync(path.join(day, 'abc.jsonl'), `${JSON.stringify(line)}\n`);
    const report = await failureReportFromTraces([dir]);
    expect(report.scanned.noAnswer).toBe(1);
    expect(report.groups[0]).toMatchObject({ failureClass: 'no-answer', agent: 'doc-qa' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads trace files from each directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-failures-'));
    const day = path.join(dir, '2026-11-01');
    fs.mkdirSync(day);
    const base = { v: 1, traceId: 'abc', startTime: T0, endTime: T0 + 1 };
    const lines = [
      { ...base, id: 'abc', name: 'invoke_agent support', status: { code: 'error' }, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', error: 'boom' } },
      { ...base, id: 's1', parentId: 'abc', name: 'execute_tool lookup', status: { code: 'error' }, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', 'gen_ai.agent.name': 'support', error: 'boom' } },
      { ...base, id: 's2', parentId: 'abc', name: 'chat m', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.agent.name': 'support' } },
    ];
    fs.writeFileSync(path.join(day, 'abc.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const report = await failureReportFromTraces([dir]);
    expect(report.scanned).toEqual({ traces: 1, spans: 2, failed: 1, noAnswer: 0, interrupted: 0, lowScores: 0 });
    expect(report.groups[0]).toMatchObject({ agent: 'support', source: 'lookup', example: 'boom' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatFailureReport', () => {
  it('says how many runs ended without an answer', () => {
    expect(formatFailureReport({ scanned: { traces: 3, spans: 9, failed: 0, noAnswer: 2, interrupted: 0, lowScores: 0 }, groups: [] })).toContain('2 runs ended without an answer');
  });

  it('says plainly when nothing failed, with what was scanned', () => {
    const text = formatFailureReport({ scanned: { traces: 6, spans: 10, failed: 0, noAnswer: 0, interrupted: 0, lowScores: 0 }, groups: [] });
    expect(text).toContain('No failures');
    expect(text).toContain('6 traces');
  });

  it('marks recurring failures and links their traces', () => {
    const text = formatFailureReport({ scanned: { traces: 2, spans: 4, failed: 2, noAnswer: 0, interrupted: 0, lowScores: 0 }, groups: groupFailures([sample({ traceId: 't1' }), sample({ traceId: 't2' })]) });
    expect(text).toContain('RECURRING');
    expect(text).toContain('timeout');
    expect(text).toContain('t1');
  });
});
