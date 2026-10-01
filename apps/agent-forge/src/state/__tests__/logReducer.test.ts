import { describe, it, expect } from 'vitest';
import { appendLog, filterLogs } from '../logReducer';
import type { LogEntry } from '../../../shared/wireTypes';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: overrides.id ?? Math.random().toString(36),
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    level: 'info',
    phase: 'trigger',
    message: 'hello',
    ...overrides,
  };
}

describe('appendLog', () => {
  it('appends within capacity', () => {
    const buf = appendLog([entry({ id: '1' })], entry({ id: '2' }), 10);
    expect(buf.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('evicts the oldest entry once at capacity, keeping the buffer at exactly `capacity`', () => {
    let buf: LogEntry[] = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    buf = appendLog(buf, entry({ id: 'd' }), 3);
    expect(buf.map((e) => e.id)).toEqual(['b', 'c', 'd']);
    expect(buf).toHaveLength(3);
  });

  it('never mutates the input buffer', () => {
    const original = [entry({ id: '1' })];
    const next = appendLog(original, entry({ id: '2' }), 10);
    expect(original).toHaveLength(1);
    expect(next).not.toBe(original);
  });
});

describe('filterLogs', () => {
  const buf: LogEntry[] = [
    entry({ id: '1', level: 'info', phase: 'trigger', message: 'run started' }),
    entry({ id: '2', level: 'tool', phase: 'tool', toolName: 'current-date', message: 'Tool call: current-date' }),
    entry({ id: '3', level: 'error', phase: 'tool', toolName: 'current-date', message: 'Tool failed: boom' }),
  ];

  it('returns everything when no filter is set', () => {
    expect(filterLogs(buf, {})).toHaveLength(3);
  });

  it('filters by level', () => {
    const result = filterLogs(buf, { levels: new Set(['error']) });
    expect(result.map((e) => e.id)).toEqual(['3']);
  });

  it('filters by phase', () => {
    const result = filterLogs(buf, { phases: new Set(['tool']) });
    expect(result.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('filters by case-insensitive search text against message and toolName', () => {
    expect(filterLogs(buf, { search: 'BOOM' }).map((e) => e.id)).toEqual(['3']);
    expect(filterLogs(buf, { search: 'current-date' }).map((e) => e.id)).toEqual(['2', '3']);
  });

  it('combines level/phase/search filters with AND semantics', () => {
    const result = filterLogs(buf, { levels: new Set(['tool']), phases: new Set(['tool']), search: 'call' });
    expect(result.map((e) => e.id)).toEqual(['2']);
  });
});
