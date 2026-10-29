import { describe, expect, it } from 'vitest';

import type { ObserveEvaluator, ObserveScoreRow } from '../../../observe/types';
import { blankDraft, draftFrom, evaluatorPatch, toNewEvaluator } from '../evaluatorDraft';
import { evaluatorPath, evaluatorsPath, filterSummary, groupOnlineRuns, parseListState, runsCapped } from '../evaluatorsUrl';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const score = (name: string, created_at: number, source = 'online'): ObserveScoreRow => ({
  score_id: `${name}-${created_at}`,
  trace_id: 't',
  obs_id: null,
  name,
  value: 1,
  source,
  comment: null,
  agent_id: null,
  created_at,
});

describe('evaluator paths', () => {
  it('reads kind/enabled/offset, ignoring unknown values, and writes no defaults', () => {
    expect(parseListState(new URLSearchParams('kind=judge&enabled=false&offset=50'))).toEqual({ kind: 'judge', enabled: false, offset: 50 });
    expect(parseListState(new URLSearchParams('kind=x&enabled=yes&offset=-1'))).toEqual({ kind: undefined, enabled: undefined, offset: 0 });
    expect(evaluatorsPath()).toBe('/evals/evaluators');
    expect(evaluatorsPath({ kind: 'code', enabled: true, offset: 0 })).toBe('/evals/evaluators?kind=code&enabled=true');
    expect(evaluatorPath('a b')).toBe('/evals/evaluators/a%20b');
    expect(evaluatorPath('r1', { enabled: false, offset: 50 })).toBe('/evals/evaluators/r1?enabled=false&offset=50');
  });

  it('summarises a filter', () => {
    expect(filterSummary({})).toBe('All traces');
    expect(filterSummary({ agent_id: 'a', status: 'error', name_contains: 'turn' })).toBe('agent=a, status=error, name~turn');
  });
});

describe('groupOnlineRuns', () => {
  it('groups online scores by name: newest time, and the count inside the last 24h', () => {
    const runs = groupOnlineRuns(
      [score('a', NOW - 1_000), score('b', NOW - 2 * DAY), score('a', NOW - DAY + 1), score('a', NOW - DAY - 1), score('a', NOW, 'human')],
      NOW,
    );
    expect(runs.get('a')).toEqual({ lastRun: NOW - 1_000, runs24h: 2 });
    expect(runs.get('b')).toEqual({ lastRun: NOW - 2 * DAY, runs24h: 0 });
    expect(runs.size).toBe(2);
  });

  it('flags a full read whose oldest row is inside the day as capped', () => {
    expect(runsCapped([score('a', NOW - 1), score('a', NOW - 2)], NOW, 2)).toBe(true);
    expect(runsCapped([score('a', NOW - 1), score('a', NOW - 2 * DAY)], NOW, 2)).toBe(false);
    expect(runsCapped([score('a', NOW - 1)], NOW, 2)).toBe(false);
  });
});

describe('evaluatorPatch', () => {
  const rule: ObserveEvaluator = {
    rule_id: 'r1',
    name: 'answered',
    enabled: true,
    filter: { status: 'ok', agent_id: 'bot' },
    sample_rate: 1,
    kind: 'code',
    config: { source: '(trace) => 1' },
    created_at: 0,
    updated_at: 0,
  };

  it('is empty for an untouched draft (filter key order ignored)', () => {
    expect(evaluatorPatch(rule, toNewEvaluator(draftFrom(rule, [])))).toEqual({});
  });

  it('carries the config with a changed kind', () => {
    const draft = { ...draftFrom(rule, []), kind: 'judge' as const, provider: 'mock', rubric: 'ok?' };
    expect(evaluatorPatch(rule, toNewEvaluator(draft))).toEqual({ kind: 'judge', config: { model: 'mock', rubric: 'ok?' } });
  });

  it('starts a new draft as an enabled code rule on every trace', () => {
    expect(toNewEvaluator({ ...blankDraft([]), name: ' x ' })).toMatchObject({ name: 'x', kind: 'code', enabled: true, filter: {}, sample_rate: 1 });
  });
});
