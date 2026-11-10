import { describe, it, expect } from 'vitest';
import { WORK_TYPES } from './page';
import { formatArtifactUri, isTerminalStatus, parseArtifactUri, PAGE_RUN_STATUSES, STEP_KINDS, WORK_TYPE_STEP_KINDS } from './execution';

describe('execution contract', () => {
  it('isTerminalStatus', () => {
    expect(PAGE_RUN_STATUSES.filter(isTerminalStatus)).toEqual(['ok', 'failed', 'timed-out', 'cancelled']);
    expect(isTerminalStatus('needs-approval')).toBe(false);
  });

  it('artifact uri round-trips through parseArtifactUri', () => {
    const parts = { workspace: 'marketing', runId: 'run_01H', name: 'drafts/post 1.md' };
    const uri = formatArtifactUri(parts);
    expect(uri).toBe('artifact://marketing/run_01H/drafts%2Fpost%201.md');
    expect(parseArtifactUri(uri)).toEqual(parts);
  });

  it('rejects malformed artifact uris', () => {
    expect(parseArtifactUri('file://marketing/run/a.md')).toBeUndefined();
    expect(parseArtifactUri('artifact://marketing/run')).toBeUndefined();
    expect(parseArtifactUri('artifact://marketing//a.md')).toBeUndefined();
    expect(parseArtifactUri('artifact://Marketing/run/a.md')).toBeUndefined();
    expect(parseArtifactUri('artifact://marketing/run/a/b.md')).toBeUndefined();
    expect(parseArtifactUri('artifact://marketing/run/%E0%A4%A')).toBeUndefined();
    expect(parseArtifactUri('artifact://marketing/run/..')).toBeUndefined();
  });

  it('every WorkType lists the step kinds it may emit', () => {
    expect(STEP_KINDS).toEqual(['single', 'workflow-step', 'delegate', 'goal-iteration']);
    for (const type of WORK_TYPES) {
      expect(WORK_TYPE_STEP_KINDS[type].length).toBeGreaterThan(0);
      for (const kind of WORK_TYPE_STEP_KINDS[type]) expect(STEP_KINDS).toContain(kind);
    }
    expect(WORK_TYPE_STEP_KINDS['goal-oriented']).toEqual(['goal-iteration', 'delegate']);
    expect(WORK_TYPE_STEP_KINDS.single).toEqual(['single']);
    expect(WORK_TYPE_STEP_KINDS.workflow).toContain('workflow-step');
    expect(WORK_TYPE_STEP_KINDS['multi-agent']).toContain('delegate');
  });
});
