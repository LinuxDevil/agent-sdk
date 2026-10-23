import { useMemo, useState } from 'react';
import { useAgents, useScores } from './useObserve';
import type { ObserveScoreRow } from './types';
import { fmtDateTime, fmtInt, fmtPercent } from './format';
import { ObserveDaemonDown, ObserveError } from './chrome';
import { ObserveDaemonDownError } from './observeClient';

const LIMIT = 200;
const DAY_MS = 86_400_000;
/** A numeric score at/above this counts as a pass for the per-eval trend (eval scores land 0..1). */
const PASS_AT = 0.5;

interface EvalTrend {
  name: string;
  count: number;
  mean: number | null;
  passRate: number | null;
  /** Daily pass fractions, oldest first - the trend strip. */
  days: { start: number; passRate: number; count: number }[];
}

/** Group score rows by eval `name`: count, mean, overall pass rate and the per-day pass-rate strip. */
function evalTrends(scores: ObserveScoreRow[]): EvalTrend[] {
  const byName = new Map<string, ObserveScoreRow[]>();
  for (const score of scores) {
    const list = byName.get(score.name) ?? [];
    list.push(score);
    byName.set(score.name, list);
  }
  const trends: EvalTrend[] = [];
  for (const [name, rows] of byName) {
    const scored = rows.filter((row) => row.value !== null);
    const mean = scored.length ? scored.reduce((sum, row) => sum + row.value!, 0) / scored.length : null;
    const passRate = scored.length ? scored.filter((row) => row.value! >= PASS_AT).length / scored.length : null;
    const byDay = new Map<number, { pass: number; count: number }>();
    for (const row of scored) {
      const day = row.created_at - (row.created_at % DAY_MS);
      const bucket = byDay.get(day) ?? { pass: 0, count: 0 };
      bucket.count += 1;
      if (row.value! >= PASS_AT) bucket.pass += 1;
      byDay.set(day, bucket);
    }
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, bucket]) => ({ start, passRate: bucket.pass / bucket.count, count: bucket.count }));
    trends.push({ name, count: rows.length, mean, passRate, days });
  }
  return trends.sort((a, b) => b.count - a.count);
}

function TrendStrip({ trend }: { trend: EvalTrend }) {
  return (
    <div className="score-trend">
      <div className="score-trend-head">
        <b>{trend.name}</b>
        <span className="observe-meta">
          {fmtInt(trend.count)} scores · mean {trend.mean === null ? '-' : trend.mean.toFixed(2)} · pass{' '}
          {trend.passRate === null ? '-' : fmtPercent(trend.passRate)}
        </span>
      </div>
      <div className="score-trend-strip" role="img" aria-label={`${trend.name} daily pass rate`}>
        {trend.days.map((day) => (
          <div
            key={day.start}
            className={`score-trend-day${day.passRate >= PASS_AT ? ' pass' : ' fail'}`}
            title={`${new Date(day.start).toLocaleDateString()} - ${fmtPercent(day.passRate)} pass (${day.count})`}
            style={{ height: `${Math.max(15, day.passRate * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * `GET /api/v1/scores` - eval/judge/human score rows with the daemon's
 * `name`/`agent_id`/`trace_id` filters, plus a per-eval-name pass-rate
 * trend computed over the returned window. A score id links back to its
 * trace (ObserveView opens {@link TraceDetailView}).
 */
export function ScoresPanel({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const agents = useAgents();
  const { data, error, loading } = useScores({ name: name || undefined, agent_id: agentId || undefined, limit: LIMIT });

  const trends = useMemo(() => evalTrends(data ?? []), [data]);
  const names = useMemo(() => [...new Set((data ?? []).map((s) => s.name))].sort(), [data]);

  if (error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;

  return (
    <div className="observe-panel">
      <div className="observe-filter-bar">
        <label>
          Eval
          <select className="select" value={name} onChange={(e) => setName(e.target.value)}>
            <option value="">All evals</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.agent_id} value={agent.agent_id}>
                {agent.name ?? agent.agent_id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ObserveError error={error} />
      {loading && data === undefined ? (
        <div className="observe-loading">Loading scores...</div>
      ) : (data?.length ?? 0) === 0 ? (
        <div className="observe-empty">
          <p>No scores yet - eval results land here once a run's evals emit score events.</p>
        </div>
      ) : (
        <>
          {trends.length > 0 && (
            <div className="score-trends">
              {trends.map((trend) => (
                <TrendStrip key={trend.name} trend={trend} />
              ))}
            </div>
          )}
          <div className="observe-table-wrap">
            <table className="observe-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Eval</th>
                  <th className="observe-num">Value</th>
                  <th>Source</th>
                  <th>Trace</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {data!.map((score) => (
                  <tr key={score.score_id}>
                    <td>{fmtDateTime(score.created_at)}</td>
                    <td>{score.name}</td>
                    <td className={`observe-num${score.value !== null && score.value < PASS_AT ? ' insight-bad' : ''}`}>
                      {score.value === null ? '-' : score.value}
                    </td>
                    <td>{score.source}</td>
                    <td>
                      <button className="btn btn-ghost observe-id" onClick={() => onOpenTrace(score.trace_id)}>
                        {score.trace_id.slice(0, 10)}
                      </button>
                    </td>
                    <td className="observe-cell-muted">{score.comment ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
