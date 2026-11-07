import { describe, it, expect } from 'vitest';
import { AUTHOR_TOOL_NAMES } from '../../../server/author/toolNames';
import { ACTIVITY_LABELS, activityLabelFor, activityStateOf } from '../activityLabels';
import type { AuthorToolPart } from '../../../shared/authorWire';

function part(over: Partial<AuthorToolPart>): AuthorToolPart {
  return { type: 'tool', toolCallId: 't1', name: 'getCurrentSpec', input: {}, state: 'done', ...over };
}

describe('ACTIVITY_LABELS', () => {
  it('has a busy/done/failed row for every Author tool name', () => {
    for (const name of AUTHOR_TOOL_NAMES) {
      const row = ACTIVITY_LABELS[name];
      expect(row, `missing ACTIVITY_LABELS row for ${name}`).toBeDefined();
      expect(row.busy, `${name}.busy`).toBeTruthy();
      expect(row.done, `${name}.done`).toBeTruthy();
      expect(row.failed, `${name}.failed`).toBeTruthy();
    }
  });

  it('falls back to the generic row for an unknown tool', () => {
    expect(activityLabelFor('mcp__jira__comment', 'busy')).toBe('Working');
    expect(activityLabelFor('mcp__jira__comment', 'done')).toBe('Done');
    expect(activityLabelFor('mcp__jira__comment', 'failed')).toBe('A step failed');
  });
});

describe('activityStateOf', () => {
  it('is busy while the part is pending', () => {
    expect(activityStateOf(part({ state: 'pending' }))).toBe('busy');
  });

  it('is done on a settled ok output', () => {
    expect(activityStateOf(part({ state: 'done', output: { ok: true } }))).toBe('done');
    expect(activityStateOf(part({ state: 'done', output: { spec: {} } }))).toBe('done');
  });

  it('is failed on state error or output.ok === false', () => {
    expect(activityStateOf(part({ state: 'error' }))).toBe('failed');
    expect(activityStateOf(part({ state: 'done', output: { ok: false, code: 'NOT_FOUND' } }))).toBe('failed');
  });
});
