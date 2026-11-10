import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { WORK_TYPES } from './page';
import { formatArtifactUri, isTerminalStatus, parseArtifactUri, PAGE_RUN_STATUSES, STEP_KINDS, WORK_TYPE_STEP_KINDS } from './execution';

describe('execution contract', () => {
  it('isTerminalStatus', () => {
    expect(PAGE_RUN_STATUSES.filter(isTerminalStatus)).toEqual(['ok', 'failed', 'timed-out', 'cancelled']);
    expect(isTerminalStatus('needs-approval')).toBe(false);
  });

  it('artifact uri round-trips through parseArtifactUri', () => {
    const parts = { workspace: 'marketing', runId: 'run_01H', name: 'post 1.md' };
    const uri = formatArtifactUri(parts);
    expect(uri).toBe('artifact://marketing/run_01H/post%201.md');
    expect(parseArtifactUri(uri)).toEqual(parts);
  });

  it.each([
    'file://marketing/run/a.md',
    'artifact://marketing/run',
    'artifact://marketing//a.md',
    'artifact://Marketing/run/a.md',
    'artifact://marketing/run/a/b.md',
    'artifact://marketing/run/%E0%A4%A',
    'artifact://marketing/run/..',
    'artifact://marketing/run/.hidden',
    'artifact://marketing/run/..%2F..%2Fsecrets',
    'artifact://marketing/..%2F..%2Fother/a.md',
    'artifact://marketing/run/%2Fetc%2Fpasswd',
    'artifact://marketing/run/..%5C..%5Cx',
    'artifact://marketing/run/a%5Cb',
    'artifact://marketing/run/a%00b',
    'artifact://marketing/run/a%0Ab',
    'artifact://marketing/run/a%7Fb',
    'artifact://marketing/%2E%2E/a.md',
  ])('parseArtifactUri rejects %s', (uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined();
  });

  it.each([
    { workspace: 'Marketing', runId: 'run', name: 'a.md' },
    { workspace: 'marketing', runId: '', name: 'a.md' },
    { workspace: 'marketing', runId: '../../other', name: 'a.md' },
    { workspace: 'marketing', runId: 'run', name: '../../secrets' },
    { workspace: 'marketing', runId: 'run', name: '/etc/passwd' },
    { workspace: 'marketing', runId: 'run', name: '..\\..\\x' },
    { workspace: 'marketing', runId: 'run', name: 'a\u0000b' },
    { workspace: 'marketing', runId: 'run', name: '.env' },
  ])('formatArtifactUri rejects $workspace / $runId / $name', (parts) => {
    expect(() => formatArtifactUri(parts)).toThrow(ValidationError);
  });

  it('formatArtifactUri names every bad part with LOUSHO_VALIDATION_FAILED', () => {
    let caught: unknown;
    try {
      formatArtifactUri({ workspace: 'Bad', runId: '..', name: 'a/b' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toMatchObject({ code: 'LOUSHO_VALIDATION_FAILED' });
    expect(Object.keys((caught as ValidationError).errors ?? {})).toEqual(['workspace', 'runId', 'name']);
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
