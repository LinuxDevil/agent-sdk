import { useMemo } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';

import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { fmtDateTime, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveAgentRow, ObserveScorePassRate } from '../../observe/types';
import { useAgents, useDaemonDown, useDaemonHealth, useEvalScores, useScorePassRates } from '../../observe/useObserve';
import { useQueryState } from '../../router/useRoute';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { MetricCard } from '../../ui/MetricCard';
import { formatTimeRange, toWindow, type TimeRange } from '../../ui/TimeRangePicker';
import { EvalsHeader } from '../evals/EvalsTabs';
import { EVAL_ROW_LIMIT, EvalDetail, PassRateBar } from './EvalDetail';
import {
  formatEvals,
  formatRange,
  formatText,
  parseEvals,
  parseRange,
  parseSource,
  parseText,
  SCORE_SOURCES,
  summarizeRates,
  trendWindow,
} from './scoresData';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
import './scores.css';

const DESCRIPTION = 'Pass rates and scores from evals and online evaluators';
/** A metric the loaded data can't give (an error, or nothing scored). */
const NONE = '—';

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
          className="scores-toggle"
          title={r.name}
          aria-expanded={r.name === open}
          aria-controls={r.name === open ? 'scores-detail' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            toggle(r.name);
          }}
        >
          <ChevronRight className="scores-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="scores-toggle-name">{r.name}</span>
        </button>
      ),
    },
    {
      key: 'pass',
      header: <span title={AGGREGATE_NOTE}>Score pass rate</span>,
      label: 'Score pass rate',
      align: 'right',
      width: 200,
      render: (r) => <PassRateBar rate={r.pass_rate} />,
    },
    { key: 'count', header: 'Scores', align: 'right', width: 110, render: (r) => fmtInt(r.count) },
    {
      key: 'mean',
      header: <span title={AGGREGATE_NOTE}>Mean score</span>,
      label: 'Mean score',
      align: 'right',
      width: 120,
      hideBelow: 480,
      render: (r) => (r.avg_value === null ? '-' : r.avg_value.toFixed(2)),
    },
    { key: 'last', header: 'Last seen', width: 150, hideBelow: 560, render: (r) => fmtDateTime(r.last_ts) },
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

/** Evals run, score pass rate and mean score over the evals in the table (no extra fetch); "—" when unknown. */
function ScoresMetrics({ rows, loading, known }: { rows: ObserveScorePassRate[]; loading: boolean; known: boolean }) {
  const s = summarizeRates(rows);
  const show = (text: string) => (known && s.evals > 0 ? text : NONE);
  return (
    <div className="scores-metrics">
      <MetricCard label="Evals run" value={known ? fmtInt(s.evals) : NONE} hint="in this window" loading={loading} />
      <MetricCard
        label="Score pass rate"
        value={show(fmtPercent(s.passRate))}
        hint={known ? `across ${fmtInt(s.scores)} scores` : 'across every score'}
        loading={loading}
      />
      <MetricCard label="Avg score" value={show(s.mean === null ? NONE : s.mean.toFixed(2))} hint="count-weighted mean" loading={loading} />
    </div>
  );
}

/**
 * `#/evals/scores?eval=&agent=&source=&range=&open=` - metric cards over the
 * filtered evals, then one row per eval (pass rate, scores, mean, last seen
 * from `?aggregate=eval`); expanding a row (`open=`) shows that eval's
 * pass-rate trend, per-check pass rates and newest failures, each linking to
 * its trace. Every filter lives in the query string (defaults unwritten), so a
 * reload keeps them. A dead daemon shows the shared down state with the URL
 * kept and the screen recovers in place.
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
  const firstLoad = rates.loading && rates.data === undefined;

  if (down)
    return (
      <div className="scores-screen">
        <EvalsHeader description={DESCRIPTION} />
        <ObserveDaemonDown />
      </div>
    );
  return (
    <div className="scores-screen">
      <EvalsHeader description={DESCRIPTION} />
      <h2 className="visually-hidden">Scores</h2>
      <FilterBar facets={facets} range={{ value: f.range, onChange: f.setRange }} />
      <ObserveError error={rates.error} />
      <ScoresMetrics rows={rows} loading={firstLoad} known={rates.data !== undefined} />
      <Card title="Evals" description="Expand an eval for its run pass rate, checks and latest failures." padding="none">
        <DataTable
          id="scores-evals"
          columns={evalColumns(f.open, toggle)}
          rows={rows}
          rowKey={(r) => r.name}
          selectedKey={f.open || undefined}
          onRowOpen={(r) => toggle(r.name)}
          loading={firstLoad}
          empty={
            <EmptyState
              icon={Gauge}
              title="No eval scores in this window"
              hint="Eval results land here once a run's evals emit score events; try a longer range or clear a filter."
            />
          }
        />
      </Card>
      {f.open && <EvalDetail key={f.open} evalName={f.open} query={detail} window={trend} />}
    </div>
  );
}
