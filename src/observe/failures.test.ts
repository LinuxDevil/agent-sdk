import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { failureReportFromDb, failureReportFromTraces, formatFailureReport, groupFailures, type FailureSample } from './failures';
import { ingestBatch, openDb } from './store';

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
    expect(report.scanned).toEqual({ traces: 3, spans: 4, failed: 3 });
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

  it('survives attrs that are not valid JSON objects', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'boom')]);
    db.prepare("UPDATE observations SET attrs = 'not json' WHERE obs_id = 'o1'").run();
    expect(failureReportFromDb(db, {}).groups).toEqual([]);
    db.close();
  });
});

describe('failureReportFromTraces', () => {
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
    expect(report.scanned).toEqual({ traces: 1, spans: 2, failed: 1 });
    expect(report.groups[0]).toMatchObject({ agent: 'support', source: 'lookup', example: 'boom' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatFailureReport', () => {
  it('says plainly when nothing failed, with what was scanned', () => {
    const text = formatFailureReport({ scanned: { traces: 6, spans: 10, failed: 0 }, groups: [] });
    expect(text).toContain('No failures');
    expect(text).toContain('6 traces');
  });

  it('marks recurring failures and links their traces', () => {
    const text = formatFailureReport({ scanned: { traces: 2, spans: 4, failed: 2 }, groups: groupFailures([sample({ traceId: 't1' }), sample({ traceId: 't2' })]) });
    expect(text).toContain('RECURRING');
    expect(text).toContain('timeout');
    expect(text).toContain('t1');
  });
});
