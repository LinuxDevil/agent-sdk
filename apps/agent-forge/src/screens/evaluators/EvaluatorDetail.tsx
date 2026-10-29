/**
 * `#/evals/evaluators/:id` - one online evaluator rule: the shared form (a
 * save sends only the changed fields, `PUT /api/v1/evaluators/:id`), Delete
 * (after a confirm), and "Test on trace" - a dry run of the rule on one trace
 * through the Studio server (`POST /observe/api/v1/evaluators/:id/test`,
 * which runs a judge with Studio's provider keys and forwards a code rule to
 * the daemon), showing the value and comment; no score is written.
 * `?trace=` prefills the trace id.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { FlaskConical, Trash2 } from 'lucide-react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { NewEvaluator, ObserveEvaluator, ObserveEvaluatorTestResult } from '../../observe/types';
import { useAgents, useDaemonDown, useEvaluator } from '../../observe/useObserve';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { EvalsHeader } from '../evals/EvalsTabs';
import { useProviderKeys } from '../playground/ModelPicker';
import { KIND_LABEL } from './EvaluatorCard';
import { draftFrom, evaluatorPatch } from './evaluatorDraft';
import { EvaluatorForm } from './EvaluatorForm';
import { evaluatorsPath, parseListState } from './evaluatorsUrl';

/** "Test on trace": a trace id, a Test button, and the dry run's value and comment. */
function TestOnTrace({ rule, prefill }: { rule: ObserveEvaluator; prefill: string }) {
  const toast = useToast();
  const [traceId, setTraceId] = useState(prefill);
  const [result, setResult] = useState<ObserveEvaluatorTestResult | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const id = traceId.trim();
    if (!id) return;
    setRunning(true);
    setResult(undefined);
    setNotFound(false);
    try {
      setResult(await observeClient.testEvaluator(rule.rule_id, id));
    } catch (failure) {
      if (failure instanceof ObserveApiError && failure.status === 404) setNotFound(true);
      else toast.show({ tone: 'error', message: `Test failed: ${(failure as Error).message}` });
    } finally {
      setRunning(false);
    }
  };

  return (
    <form className="card ev-test" aria-label="Test on trace" onSubmit={(e) => void run(e)}>
      <div className="ev-test-head">
        <h3 className="card-title">Test on trace</h3>
        <p className="card-description">Runs this rule once on one trace. No score is written.</p>
      </div>
      <div className="ev-test-fields">
        <label className="ds-field ev-grow">
          <span className="ds-field-label">Trace id</span>
          <input
            className="input ev-mono-input"
            name="test-trace-id"
            type="text"
            value={traceId}
            placeholder="Paste a trace id"
            onChange={(e) => setTraceId(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={running || traceId.trim() === ''}>
          <FlaskConical aria-hidden="true" />
          Test
        </button>
      </div>
      {notFound && (
        <p className="datasets-form-error" role="alert">
          Trace not found
        </p>
      )}
      {result && (
        <dl className="ev-result" aria-label="Test result">
          <dt>Value</dt>
          <dd>{result.value === null ? 'null' : String(result.value)}</dd>
          <dt>Comment</dt>
          <dd>{result.comment ?? <span className="value-missing">—</span>}</dd>
        </dl>
      )}
    </form>
  );
}

/** The edit form, Delete and Test on trace for a loaded rule; a save or delete reports through a toast. */
function EditRule({ rule, back, onSaved }: { rule: ObserveEvaluator; back: string; onSaved: () => void }) {
  const toast = useToast();
  const keys = useProviderKeys();
  const agents = useAgents();
  const { query } = useRoute();

  const save = async (body: NewEvaluator) => {
    const patch = evaluatorPatch(rule, body);
    if (Object.keys(patch).length === 0) {
      toast.show({ message: 'No changes to save.' });
      return false;
    }
    await observeClient.updateEvaluator(rule.rule_id, patch);
    toast.show({ tone: 'success', message: `Saved evaluator ${body.name}.` });
    onSaved();
    return false;
  };
  const remove = async () => {
    if (!window.confirm(`Delete evaluator ${rule.name}? Its past scores stay.`)) return;
    try {
      await observeClient.deleteEvaluator(rule.rule_id);
      toast.show({ tone: 'success', message: `Deleted evaluator ${rule.name}.` });
      navigate(back);
    } catch (failure) {
      toast.show({ tone: 'error', message: `Could not delete ${rule.name}: ${(failure as Error).message}` });
    }
  };

  return (
    <div className="ev-detail">
      <EvaluatorForm
        // A save re-reads the rule: a new `updated_at` restarts the form from it.
        key={rule.updated_at}
        title="Edit evaluator"
        initial={draftFrom(rule, keys)}
        keys={keys}
        agents={agents.data ?? []}
        submitLabel="Save changes"
        onSubmit={save}
        actions={
          <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => void remove()}>
            <Trash2 aria-hidden="true" />
            Delete
          </button>
        }
      />
      <TestOnTrace rule={rule} prefill={query.get('trace') ?? ''} />
    </div>
  );
}

/** The edit view while the rule loads: a card of skeleton lines. */
const LoadingRule = () => (
  <Card title="General">
    <SkeletonRows rows={4} />
  </Card>
);

/** `#/evals/evaluators/:id`; an unknown rule shows an empty state with the way back. */
export function EvaluatorDetail({ ruleId }: { ruleId: string }) {
  const { query } = useRoute();
  const [refreshKey, setRefreshKey] = useState(0);
  const rule = useEvaluator(ruleId, refreshKey);
  const back = evaluatorsPath(parseListState(query));
  const down = useDaemonDown(false, [rule]);
  const name = rule.data?.name ?? ruleId;
  let body: ReactNode;
  if (down) body = <ObserveDaemonDown />;
  else if (rule.loading && !rule.data) body = <LoadingRule />;
  else if (rule.error) body = <ObserveError error={rule.error} />;
  else if (!rule.data)
    body = (
      <Card as="div">
        <EmptyState
          title="Evaluator not found"
          hint={`No evaluator '${ruleId}'.`}
          action={
            <a className="btn" href={`#${back}`}>
              All evaluators
            </a>
          }
        />
      </Card>
    );
  else body = <EditRule rule={rule.data} back={back} onSaved={() => setRefreshKey((k) => k + 1)} />;
  return (
    <>
      <EvalsHeader
        title={name}
        description={rule.data ? `${KIND_LABEL[rule.data.kind]} evaluator, scoring live traces as they arrive` : undefined}
        breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Evaluators', href: `#${back}` }, { label: name }]}
      />
      <h2 className="visually-hidden">Evaluator {rule.data?.name}</h2>
      {body}
    </>
  );
}
