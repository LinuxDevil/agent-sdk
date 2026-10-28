/**
 * `#/evals/evaluators` - the online evaluator rules (`GET /api/v1/evaluators`,
 * `?kind=`/`?enabled=` filters and `?offset=` paging in the URL) with an
 * enabled switch per rule and its last-run counts, plus "New evaluator" - and
 * `#/evals/evaluators/:id`, one rule's edit view (see `EvaluatorDetail.tsx`).
 * Both sit under the Evaluations tabs and behind the daemon-down state, which
 * keeps the URL and swaps the screen back in by itself once the daemon is back.
 *
 * Last-run counts come from one score read: the newest
 * {@link ONLINE_SCORES_CAP} `source=online` scores, grouped by name (a rule
 * scores under its own name). Past that cap the 24h count is a floor (`N+`).
 */
import '../datasets/datasets.css';
import '../queues/queues.css';
import './evaluators.css';
import { useMemo, useState } from 'react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useEvaluators, useOnlineScores } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { NewEvaluator, ObserveEvaluator } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/Toast';
import { Clip } from '../listFilters';
import { EvalsTabs } from '../evals/EvalsTabs';
import { useProviderKeys } from '../playground/ModelPicker';
import { blankDraft } from './evaluatorDraft';
import { EvaluatorDetail } from './EvaluatorDetail';
import { EvaluatorForm } from './EvaluatorForm';
import {
  EVALUATORS_PAGE_SIZE,
  ONLINE_SCORES_CAP,
  evaluatorPath,
  evaluatorsPath,
  filterSummary,
  groupOnlineRuns,
  parseListState,
  runsCapped,
  type EvaluatorListState,
  type RuleRuns,
} from './evaluatorsUrl';

/** The enabled switches' optimistic state: a flip shows at once, a failed `PUT` flips it back with an error toast. */
function useEnabledSwitch() {
  const toast = useToast();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isEnabled = (rule: ObserveEvaluator): boolean => overrides[rule.rule_id] ?? rule.enabled;
  const flip = async (rule: ObserveEvaluator, enabled: boolean) => {
    setOverrides((o) => ({ ...o, [rule.rule_id]: enabled }));
    try {
      await observeClient.updateEvaluator(rule.rule_id, { enabled });
    } catch (failure) {
      setOverrides((o) => ({ ...o, [rule.rule_id]: !enabled }));
      toast.show({ tone: 'error', message: `Could not ${enabled ? 'enable' : 'disable'} ${rule.name}: ${(failure as Error).message}` });
    }
  };
  return { isEnabled, flip };
}

function EnabledSwitch({ rule, on, onFlip }: { rule: ObserveEvaluator; on: boolean; onFlip: (next: boolean) => void }) {
  return (
    <label className="evaluators-switch">
      <input type="checkbox" role="switch" aria-label={`${rule.name} enabled`} checked={on} onChange={(e) => onFlip(e.target.checked)} />
      <span aria-hidden="true">{on ? 'On' : 'Off'}</span>
    </label>
  );
}

function columns(
  runs: Map<string, RuleRuns>,
  capped: boolean,
  enabled: ReturnType<typeof useEnabledSwitch>
): Column<ObserveEvaluator>[] {
  return [
    { key: 'name', header: 'Name', width: 200, render: (r) => <Clip text={r.name} /> },
    { key: 'kind', header: 'Kind', width: 80, render: (r) => r.kind },
    { key: 'filter', header: 'Filter', width: 220, hideBelow: 720, render: (r) => <Clip text={filterSummary(r.filter)} /> },
    { key: 'sample', header: 'Sample rate', align: 'right', width: 100, hideBelow: 720, render: (r) => String(r.sample_rate) },
    {
      key: 'enabled',
      header: 'Enabled',
      width: 90,
      render: (r) => <EnabledSwitch rule={r} on={enabled.isEnabled(r)} onFlip={(next) => void enabled.flip(r, next)} />,
    },
    { key: 'last', header: 'Last run', width: 140, render: (r) => fmtDateTime(runs.get(r.name)?.lastRun) },
    {
      key: 'runs',
      header: 'Runs (24h)',
      align: 'right',
      width: 100,
      render: (r) => `${fmtInt(runs.get(r.name)?.runs24h ?? 0)}${capped ? '+' : ''}`,
    },
  ];
}

/** The list's Kind and State selects; a change rewrites the URL (back to page one). */
function ListFilters({ state }: { state: EvaluatorListState }) {
  const go = (next: Partial<EvaluatorListState>) => navigate(evaluatorsPath({ ...state, ...next, offset: 0 }), { replace: true });
  return (
    <div className="evaluators-filters" role="group" aria-label="Filters">
      <label className="datasets-field">
        <span>Kind</span>
        <select
          value={state.kind ?? ''}
          onChange={(e) => go({ kind: (e.target.value || undefined) as EvaluatorListState['kind'] })}
        >
          <option value="">Any kind</option>
          <option value="code">code</option>
          <option value="judge">judge</option>
        </select>
      </label>
      <label className="datasets-field">
        <span>State</span>
        <select
          value={state.enabled === undefined ? '' : String(state.enabled)}
          onChange={(e) => go({ enabled: e.target.value === '' ? undefined : e.target.value === 'true' })}
        >
          <option value="">Enabled or disabled</option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </label>
    </div>
  );
}

/** "New evaluator": a button that opens the shared form; a create closes it and refreshes the list. */
function NewEvaluator({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const keys = useProviderKeys();
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <div className="queues-form-actions">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          New evaluator
        </button>
      </div>
    );
  const create = async (body: NewEvaluator) => {
    await observeClient.createEvaluator(body);
    toast.show({ tone: 'success', message: `Created evaluator ${body.name}.` });
    setOpen(false);
    onCreated();
    return false;
  };
  return (
    <EvaluatorForm
      title="New evaluator"
      initial={blankDraft(keys)}
      keys={keys}
      agents={agents.data ?? []}
      submitLabel="Create evaluator"
      onSubmit={create}
      actions={
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      }
    />
  );
}

function EvaluatorList() {
  const route = useRoute();
  const state = parseListState(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const list = useEvaluators({ limit: EVALUATORS_PAGE_SIZE, offset: state.offset, kind: state.kind, enabled: state.enabled }, refreshKey);
  const online = useOnlineScores(ONLINE_SCORES_CAP, refreshKey);
  const enabled = useEnabledSwitch();
  const { runs, capped } = useMemo(() => {
    const now = Date.now();
    const scores = online.data ?? [];
    return { runs: groupOnlineRuns(scores, now), capped: runsCapped(scores, now) };
  }, [online.data]);
  if (useDaemonDown(false, [list, online])) return <ObserveDaemonDown />;
  return (
    <>
      <h2 className="visually-hidden">Evaluators</h2>
      <NewEvaluator onCreated={() => setRefreshKey((k) => k + 1)} />
      <ListFilters state={state} />
      <ObserveError error={list.error} />
      <DataTable
        id="evaluators"
        columns={columns(runs, capped, enabled)}
        rows={list.data?.evaluators ?? []}
        rowKey={(r) => r.rule_id}
        onRowOpen={(r) => navigate(evaluatorPath(r.rule_id, state))}
        page={{
          offset: state.offset,
          limit: EVALUATORS_PAGE_SIZE,
          total: list.data?.total ?? 0,
          onChange: (next) => navigate(evaluatorsPath({ ...state, offset: next }), { replace: true }),
        }}
        loading={list.loading && !list.data}
        empty={
          <EmptyState
            title={state.kind || state.enabled !== undefined ? 'No evaluators match these filters' : 'No evaluators yet'}
            hint="Create one above: a code function or an LLM judge that scores new traces as they finish (source online)."
          />
        }
      />
    </>
  );
}

/** `#/evals/evaluators` and `#/evals/evaluators/:id`, under the Evaluations tabs and behind the daemon-down state. */
export function EvaluatorsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const detail = matchRoute(`#${path}`, ['/evals/evaluators/:id']);
  let body;
  if (health.down) body = <ObserveDaemonDown />;
  else if (detail) body = <EvaluatorDetail key={detail.params.id} ruleId={detail.params.id} />;
  else body = <EvaluatorList />;
  return (
    <section className="datasets-screen" aria-label="Evaluators">
      <EvalsTabs />
      {body}
    </section>
  );
}
