import { describe, expect, it } from 'vitest';

import type { TraceSummaryPayload } from '../../../../../shared/wireTypes';
import type { ObserveScoreRow } from '../../../../observe/types';
import { joinRatings } from '../runsModel';

function run(traceId: string): TraceSummaryPayload {
  return {
    traceId,
    name: `Run ${traceId}`,
    startTime: 1_000,
    durationMs: 500,
    status: 'ok',
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
  };
}

function score(traceId: string, value: number | null, createdAt: number, comment: string | null): ObserveScoreRow {
  return {
    score_id: `${traceId}-${createdAt}`,
    trace_id: traceId,
    obs_id: null,
    name: 'rating',
    value,
    source: 'human',
    comment,
    agent_id: null,
    created_at: createdAt,
  };
}

describe('joinRatings', () => {
  it('joins each run with its latest rating and keeps run order', () => {
    const runs = [run('t1'), run('t2')];
    const scores = [score('t1', 2, 1, 'wrong'), score('t1', 4, 2, null)];

    const rows = joinRatings(runs, scores);

    expect(rows.map((r) => r.traceId)).toEqual(['t1', 't2']);
    expect(rows[0].rating).toBe(4);
    expect(rows[0].ratingComment).toBeNull();
    expect(rows[1].rating).toBeNull();
    expect(rows[1].ratingComment).toBeNull();
  });

  it('ignores scores that are not human ratings and runs without any score', () => {
    const other = { ...score('t1', 5, 9, 'judge'), name: 'quality' };
    const rows = joinRatings([run('t1'), run('t2')], [other]);
    expect(rows.every((r) => r.rating === null)).toBe(true);
  });
});
