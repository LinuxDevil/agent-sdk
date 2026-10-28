import { useMemo } from 'react';

import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { fmtDateTime, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveAgentRow, ObserveScorePassRate } from '../../observe/types';
import { useAgents, useDaemonDown, useDaemonHealth, useEvalScores, useScorePassRates } from '../../observe/useObserve';
import { useQueryState } from '../../router/useRoute';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { formatTimeRange, toWindow, type TimeRange } from '../../ui/TimeRangePicker';
import { EvalsTabs } from '../evals/EvalsTabs';
import { EVAL_ROW_LIMIT, EvalDetail } from './EvalDetail';
import {
  formatEvals,
  formatRange,
  formatText,
  parseEvals,
  parseRange,
  parseSource,
  parseText,
  SCORE_SOURCES,
  trendWindow,
} from './scoresData';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
import './scores.css';

/** The query-string filters: `eval` (comma list), `agent`, `source`, `range`, and the expanded eval `open`. */
function useScoreFilters() {
  const [evals, setEvals] = useQueryState('eval', parseEvals, formatEvals);
  const [agent, setAgent] = useQueryState('agent', parseText, formatText);
  const [source, setSource] = useQueryState('source', parseSource, formatText);
  const [range, setRange] = useQueryState('range', parseRange, formatRange);
  const [open, setOpen] = useQueryState('open', parseText, formatText);
  return { evals, setEvals, agent, setAgent, source, setSource, range, setRange, open, setOpen };
}

/** The daemon's time bounds for a range; a preset's clock is re-read only when the range (or refresh) changes. */
function useBounds(range: TimeRange, refreshKey: unknown) {
  const key = formatTimeRange(range);
  return useMemo(() => {
    const now = Date.now();
    const w = toWindow(range, now);
    return { since: w.from, until: w.to, trend: trendWindow(range, now) };
    // `range` is identified by its serialised key.
  }, [key, refreshKey]);
}

/** Single-select facet over a multi-select FilterBar facet: the newest tick wins. */
function singleFacet(key: string, label: string, options: FacetDef['options'], value: string, set: (v: string) => void): FacetDef {
  return { key, label, options, value: value ? [value] : [], onChange: (next) => set(next.at(-1) ?? '') };
}

function agentOptions(agents: ObserveAgentRow[] | undefined, selected: string): FacetDef['options'] {
  const opts = (agents ?? []).map((a) => ({ value: a.agent_id, label: a.name ?? a.agent_id.slice(0, 8) }));
  return selected && !opts.some((o) => o.value === selected) ? [...opts, { value: selected, label: selected }] : opts;
}

function evalOptions(rates: ObserveScorePassRate[] | undefined, selected: string[]): FacetDef['options'] {
  const names = new Set([...(rates ?? []).map((r) => r.name), ...selected]);
  const count = new Map((rates ?? []).map((r) => [r.name, r.count]));
  return [...names].sort().map((name) => ({ value: name, label: name, count: count.get(name) }));
}

/** The aggregate folds every score of an eval, so its figures are per score, not per run. */
const AGGREGATE_NOTE = "Across every score of the eval: each run's eval-level score plus all its check scores. Expand the eval for the run pass rate.";

function evalColumns(open: string, toggle: (name: string) => void): Column<ObserveScorePassRate>[] {
  return [
    {
      key: 'name',
      header: 'Eval',
      render: (r) => (
        <button
          type="button"
          className="btn btn-ghost scores-toggle"
          aria-expanded={r.name === open}
          aria-controls={r.name === open ? 'scores-detail' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            toggle(r.name);
          }}
        >
          <span aria-hidden="true">{r.name === open ? '▾' : '▸'}</span> {r.name}
        </button>
      ),
    },
    {
      key: 'pass',
      header: <span title={AGGREGATE_NOTE}>Score pass rate</span>,
      label: 'Score pass rate',
      align: 'right',
      render: (r) => fmtPercent(r.pass_rate),
    },
    { key: 'count', header: 'Scores', align: 'right', render: (r) => fmtInt(r.count) },
    {
      key: 'mean',
      header: <span title={AGGREGATE_NOTE}>Mean score</span>,
      label: 'Mean score',
      align: 'right',
      hideBelow: 480,
      render: (r) => (r.avg_value === null ? '-' : r.avg_value.toFixed(2)),
    },
    { key: 'last', header: 'Last seen', hideBelow: 560, render: (r) => fmtDateTime(r.last_ts) },
  ];
}

/** Pass rates per eval, the expanded eval's rows and the agent list; refetched when the daemon comes back. */
function useScoresData(f: ReturnType<typeof useScoreFilters>) {
  const health = useDaemonHealth();
  const bounds = useBounds(f.range, health.down);
  const filter = { agent_id: f.agent || undefined, source: f.source || undefined, since: bounds.since, until: bounds.until };
  const rates = useScorePassRates(filter, health.down);
  const detail = useEvalScores(f.open, { ...filter, limit: EVAL_ROW_LIMIT }, health.down);
  const agents = useAgents(undefined, health.down);
  const down = useDaemonDown(health.down, [rates, detail, agents]);
  return { rates, detail, agents, down, trend: bounds.trend };
}

/**
 * `#/evals/scores?eval=&agent=&source=&range=&open=` - one row per eval
 * (pass rate, scores, mean, last seen from `?aggregate=eval`); expanding a row
 * (`open=`) shows that eval's pass-rate trend, per-check pass rates and newest
 * failures, each linking to its trace. Every filter lives in the query string
 * (defaults unwritten), so a reload keeps them. A dead daemon shows the shared
 * down state with the URL kept and the screen recovers in place.
 */
export function ScoresScreen() {
  const f = useScoreFilters();
  const { rates, detail, agents, down, trend } = useScoresData(f);
  const rows = useMemo(
    () => (rates.data ?? []).filter((r) => f.evals.length === 0 || f.evals.includes(r.name)),
    [rates.data, f.evals],
  );
  const toggle = (name: string) => f.setOpen(name === f.open ? '' : name);
  const facets: FacetDef[] = [
    { key: 'eval', label: 'Eval', options: evalOptions(rates.data, f.evals), value: f.evals, onChange: f.setEvals },
    singleFacet('agent', 'Agent', agentOptions(agents.data, f.agent), f.agent, f.setAgent),
    singleFacet('source', 'Source', SCORE_SOURCES.map((s) => ({ value: s, label: s })), f.source, f.setSource),
  ];

  if (down)
    return (
      <div className="scores-screen">
        <EvalsTabs />
        <ObserveDaemonDown />
      </div>
    );
  return (
    <div className="scores-screen">
      <EvalsTabs />
      <h2 className="visually-hidden">Scores</h2>
      <FilterBar facets={facets} range={{ value: f.range, onChange: f.setRange }} />
      <ObserveError error={rates.error} />
      <DataTable
        id="scores-evals"
        columns={evalColumns(f.open, toggle)}
        rows={rows}
        rowKey={(r) => r.name}
        onRowOpen={(r) => toggle(r.name)}
        loading={rates.loading && rates.data === undefined}
        empty={
          <EmptyState
            title="No eval scores in this window"
            hint="Eval results land here once a run's evals emit score events; try a longer range or clear a filter."
          />
        }
      />
      {f.open && <EvalDetail key={f.open} evalName={f.open} query={detail} window={trend} />}
    </div>
  );
}
