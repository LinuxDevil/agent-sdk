/**
 * `#/evals/evaluators` - the online evaluator rules as a card grid (`GET /api/v1/evaluators`,
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
import './evaluators.css';
import { useMemo, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useEvaluators, useOnlineScores } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { NewEvaluator, ObserveEvaluator, ObserveEvaluatorList } from '../../observe/types';
import { fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { TablePager } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/Toast';
import { EvalsHeader } from '../evals/EvalsTabs';
import { GridSkeleton } from '../evals/GridSkeleton';
import { useProviderKeys } from '../playground/ModelPicker';
import { blankDraft } from './evaluatorDraft';
import { EvaluatorCard } from './EvaluatorCard';
import { EvaluatorDetail } from './EvaluatorDetail';
import { EvaluatorForm } from './EvaluatorForm';
import {
  EVALUATORS_PAGE_SIZE,
  ONLINE_SCORES_CAP,
  evaluatorPath,
  evaluatorsPath,
  groupOnlineRuns,
  parseListState,
  runsCapped,
  type EvaluatorListState,
  type RuleRuns,
} from './evaluatorsUrl';

/** The list header's description (also over the daemon-down state). */
const EVALUATORS_DESCRIPTION = 'Rules that score live traces as they arrive';
const FORM_ID = 'new-evaluator-form';

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

/** The list's Kind and State selects; a change rewrites the URL (back to page one). */
function ListFilters({ state }: { state: EvaluatorListState }) {
  const go = (next: Partial<EvaluatorListState>) => navigate(evaluatorsPath({ ...state, ...next, offset: 0 }), { replace: true });
  return (
    <div className="ev-filters" role="group" aria-label="Filters">
      <label className="ev-filter">
        <span>Kind</span>
        <select
          className="select"
          value={state.kind ?? ''}
          onChange={(e) => go({ kind: (e.target.value || undefined) as EvaluatorListState['kind'] })}
        >
          <option value="">Any kind</option>
          <option value="code">code</option>
          <option value="judge">judge</option>
        </select>
      </label>
      <label className="ev-filter">
        <span>State</span>
        <select
          className="select"
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

function NewEvaluatorButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-primary" aria-expanded={open} aria-controls={open ? FORM_ID : undefined} onClick={onClick}>
      <Plus aria-hidden="true" />
      New evaluator
    </button>
  );
}

/** "New evaluator": the shared form under a title row; a create closes it and refreshes the list. */
function NewEvaluator({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const toast = useToast();
  const keys = useProviderKeys();
  const agents = useAgents();
  const create = async (body: NewEvaluator) => {
    await observeClient.createEvaluator(body);
    toast.show({ tone: 'success', message: `Created evaluator ${body.name}.` });
    onCreated();
    return false;
  };
  return (
    <div className="ev-new" id={FORM_ID}>
      <div className="ev-new-head">
        <h3 className="ev-new-title">New evaluator</h3>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close new evaluator" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <EvaluatorForm
        title="New evaluator"
        initial={blankDraft(keys)}
        keys={keys}
        agents={agents.data ?? []}
        submitLabel="Create evaluator"
        onSubmit={create}
        actions={
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        }
      />
    </div>
  );
}

/** The last-run counts per rule, from one capped read of the newest online scores. */
function useRuleRuns(refreshKey: number) {
  const online = useOnlineScores(ONLINE_SCORES_CAP, refreshKey);
  const counts = useMemo(() => {
    const now = Date.now();
    const scores = online.data ?? [];
    return { runs: groupOnlineRuns(scores, now), capped: runsCapped(scores, now) };
  }, [online.data]);
  return { online, ...counts };
}

const EMPTY_HINT = 'Create one with New evaluator: a code function or an LLM judge that scores new traces as they finish (source online).';
const FILTERED_HINT = 'Change the Kind or State filter to see more rules.';

interface EvaluatorGridProps {
  data: ObserveEvaluatorList;
  state: EvaluatorListState;
  runs: Map<string, RuleRuns>;
  capped: boolean;
  enabled: ReturnType<typeof useEnabledSwitch>;
  /** The New evaluator form is open: the empty state drops its own button. */
  creating: boolean;
  onNew: () => void;
}

/** No rules on page one: a filtered list says so, an empty one offers New evaluator. */
function NoEvaluators({ filtered, creating, onNew }: { filtered: boolean; creating: boolean; onNew: () => void }) {
  if (filtered)
    return (
      <Card as="div">
        <EmptyState icon={Sparkles} title="No evaluators match these filters" hint={FILTERED_HINT} />
      </Card>
    );
  return (
    <Card as="div">
      {creating ? (
        <EmptyState icon={Sparkles} title="No evaluators yet" hint={EMPTY_HINT} />
      ) : (
        <EmptyState icon={Sparkles} title="No evaluators yet" hint={EMPTY_HINT} action={<NewEvaluatorButton open={false} onClick={onNew} />} />
      )}
    </Card>
  );
}

/** The loaded grid (or its empty state) and, past one page, the pager. */
function EvaluatorGrid({ data, state, runs, capped, enabled, creating, onNew }: EvaluatorGridProps) {
  if (data.evaluators.length === 0 && state.offset === 0)
    return <NoEvaluators filtered={state.kind !== undefined || state.enabled !== undefined} creating={creating} onNew={onNew} />;
  return (
    <>
      {data.evaluators.length === 0 ? (
        <p className="datasets-note">No evaluators on this page.</p>
      ) : (
        <ul className="ds-grid" aria-label="Evaluators">
          {data.evaluators.map((rule) => (
            <EvaluatorCard
              key={rule.rule_id}
              rule={rule}
              href={evaluatorPath(rule.rule_id, state)}
              runs={runs.get(rule.name)}
              capped={capped}
              on={enabled.isEnabled(rule)}
              onFlip={(next) => void enabled.flip(rule, next)}
            />
          ))}
        </ul>
      )}
      {(state.offset > 0 || data.total > EVALUATORS_PAGE_SIZE) && (
        <TablePager
          offset={state.offset}
          limit={EVALUATORS_PAGE_SIZE}
          total={data.total}
          onChange={(next) => navigate(evaluatorsPath({ ...state, offset: next }), { replace: true })}
        />
      )}
    </>
  );
}

function EvaluatorList() {
  const route = useRoute();
  const state = parseListState(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const list = useEvaluators({ limit: EVALUATORS_PAGE_SIZE, offset: state.offset, kind: state.kind, enabled: state.enabled }, refreshKey);
  const { online, runs, capped } = useRuleRuns(refreshKey);
  const enabled = useEnabledSwitch();
  const down = useDaemonDown(false, [list, online]);
  const data = list.data;
  const created = () => {
    setCreating(false);
    setRefreshKey((k) => k + 1);
  };
  const header = (
    <EvalsHeader
      description={EVALUATORS_DESCRIPTION}
      actions={down ? undefined : <NewEvaluatorButton open={creating} onClick={() => setCreating((v) => !v)} />}
    />
  );
  if (down)
    return (
      <>
        {header}
        <ObserveDaemonDown />
      </>
    );
  return (
    <>
      {header}
      <h2 className="visually-hidden">Evaluators</h2>
      {creating && <NewEvaluator onClose={() => setCreating(false)} onCreated={created} />}
      <div className="ev-toolbar">
        <ListFilters state={state} />
        {data && (
          <span className="ev-count">
            {fmtInt(data.total)} {data.total === 1 ? 'rule' : 'rules'}
          </span>
        )}
      </div>
      <ObserveError error={list.error} />
      {list.loading && !data && <GridSkeleton label="Loading evaluators" />}
      {data && (
        <EvaluatorGrid
          data={data}
          state={state}
          runs={runs}
          capped={capped}
          enabled={enabled}
          creating={creating}
          onNew={() => setCreating(true)}
        />
      )}
    </>
  );
}

/** `#/evals/evaluators` and `#/evals/evaluators/:id`, under the Evaluations header and behind the daemon-down state. */
export function EvaluatorsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const detail = matchRoute(`#${path}`, ['/evals/evaluators/:id']);
  let body;
  if (health.down)
    body = (
      <>
        <EvalsHeader description={EVALUATORS_DESCRIPTION} />
        <ObserveDaemonDown />
      </>
    );
  else if (detail) body = <EvaluatorDetail key={detail.params.id} ruleId={detail.params.id} />;
  else body = <EvaluatorList />;
  return (
    <section className="ds-screen" aria-label="Evaluators">
      {body}
    </section>
  );
}
