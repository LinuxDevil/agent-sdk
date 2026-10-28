/**
 * The evaluator form the list's "New evaluator" and the edit view share:
 * name, kind (`code` with a function textarea, or `judge` with a model and a
 * rubric), the trace filter (agent, status, name contains), the sample rate
 * and the enabled flag. A judge needs a provider key: without one in Studio's
 * settings the judge option is disabled, with a hint that links Settings.
 * A failed save (a taken name is the daemon's 409) shows inline.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ProviderKeyStatus } from '../../../shared/wireTypes';
import { ObserveApiError } from '../../observe/observeClient';
import type { NewEvaluator, ObserveAgentRow } from '../../observe/types';
import { MOCK_PROVIDER, defaultProvider, providerOptions } from '../playground/request';
import { draftProblem, toNewEvaluator, type EvaluatorDraft } from './evaluatorDraft';

type SetField = <K extends keyof EvaluatorDraft>(field: K, value: EvaluatorDraft[K]) => void;

/** The save failure shown inline: a 409 is a taken name, anything else its message. */
const saveError = (error: unknown): string =>
  error instanceof ObserveApiError && error.status === 409
    ? 'Could not save: an evaluator with that name exists.'
    : `Could not save the evaluator: ${(error as Error).message}`;

function KindField({
  draft,
  choose,
  judgeAllowed,
}: {
  draft: EvaluatorDraft;
  choose: (kind: EvaluatorDraft['kind']) => void;
  judgeAllowed: boolean;
}) {
  return (
    <fieldset className="evaluators-kind">
      <legend>Kind</legend>
      <label>
        <input type="radio" name="evaluator-kind" value="code" checked={draft.kind === 'code'} onChange={() => choose('code')} />
        Code
      </label>
      <label>
        <input
          type="radio"
          name="evaluator-kind"
          value="judge"
          checked={draft.kind === 'judge'}
          disabled={!judgeAllowed}
          aria-describedby={judgeAllowed ? undefined : 'evaluator-judge-hint'}
          onChange={() => choose('judge')}
        />
        LLM judge
      </label>
      {!judgeAllowed && (
        <p id="evaluator-judge-hint" className="datasets-note">
          Add a provider key in <a href="#/settings">Settings</a> to use judge evaluators.
        </p>
      )}
    </fieldset>
  );
}

function FilterFields({ draft, set, agents }: { draft: EvaluatorDraft; set: SetField; agents: ObserveAgentRow[] }) {
  const known = agents.some((a) => a.agent_id === draft.agentId);
  return (
    <fieldset className="evaluators-filter">
      <legend>Runs on traces where</legend>
      <label className="datasets-field">
        <span>Agent</span>
        <select name="evaluator-agent" value={draft.agentId} onChange={(e) => set('agentId', e.target.value)}>
          <option value="">Any agent</option>
          {draft.agentId && !known && <option value={draft.agentId}>{draft.agentId}</option>}
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.name ?? a.agent_id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <label className="datasets-field">
        <span>Status</span>
        <select name="evaluator-status" value={draft.status} onChange={(e) => set('status', e.target.value as EvaluatorDraft['status'])}>
          <option value="">Any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </select>
      </label>
      <label className="datasets-field datasets-field-wide">
        <span>Name contains</span>
        <input name="evaluator-name-contains" type="text" value={draft.nameContains} onChange={(e) => set('nameContains', e.target.value)} />
      </label>
    </fieldset>
  );
}

function JudgeFields({ draft, set, keys }: { draft: EvaluatorDraft; set: SetField; keys: readonly ProviderKeyStatus[] }) {
  const options = providerOptions(keys);
  if (draft.provider !== '' && !options.includes(draft.provider)) options.unshift(draft.provider);
  const isMock = draft.provider === MOCK_PROVIDER;
  return (
    <>
      <div className="datasets-new-fields">
        <label className="datasets-field">
          <span>Provider</span>
          <select name="evaluator-provider" value={draft.provider} onChange={(e) => set('provider', e.target.value)}>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="">custom (provider/model)</option>
          </select>
        </label>
        <label className="datasets-field datasets-field-wide">
          <span>Model</span>
          <input
            name="evaluator-model"
            type="text"
            value={isMock ? '' : draft.model}
            disabled={isMock}
            placeholder={draft.provider === '' ? 'provider/model' : 'model name'}
            onChange={(e) => set('model', e.target.value)}
          />
        </label>
      </div>
      <label className="datasets-field">
        <span>Rubric</span>
        <textarea
          name="evaluator-rubric"
          className="evaluators-text"
          rows={5}
          value={draft.rubric}
          placeholder="Score 1 when the reply answers the question, 0 otherwise."
          onChange={(e) => set('rubric', e.target.value)}
        />
      </label>
    </>
  );
}

interface EvaluatorFormProps {
  /** The form's accessible name and heading. */
  title: string;
  initial: EvaluatorDraft;
  keys: readonly ProviderKeyStatus[];
  agents: ObserveAgentRow[];
  submitLabel: string;
  /** Saves the rule; a rejection shows inline. Resolving `true` resets the form to `initial`. */
  onSubmit: (body: NewEvaluator) => Promise<boolean>;
  /** Extra buttons beside the submit (the edit view's Delete). */
  actions?: ReactNode;
}

/** The create/edit form; it owns the draft, the parent owns the request. */
export function EvaluatorForm({ title, initial, keys, agents, submitLabel, onSubmit, actions }: EvaluatorFormProps) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const set: SetField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));
  const judgeAllowed = keys.some((k) => k.hasKey) || initial.kind === 'judge';
  const problem = draftProblem(draft);
  // The keys load after the draft is made: a judge with no model typed yet starts on the first keyed provider.
  const choose = (kind: EvaluatorDraft['kind']) =>
    setDraft((d) => (kind === 'judge' && d.kind !== 'judge' && d.model === '' ? { ...d, kind, provider: defaultProvider(keys) } : { ...d, kind }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(undefined);
    try {
      if (await onSubmit(toNewEvaluator(draft))) setDraft(initial);
    } catch (failure) {
      setError(saveError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="datasets-new evaluators-form" aria-label={title} onSubmit={(e) => void submit(e)}>
      <h3 className="datasets-section-title">{title}</h3>
      <div className="datasets-new-fields">
        <label className="datasets-field datasets-field-wide">
          <span>Name</span>
          <input name="evaluator-name" type="text" value={draft.name} placeholder="e.g. answered" onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="datasets-field">
          <span>Sample rate (0-1)</span>
          <input
            name="evaluator-sample-rate"
            type="number"
            min={0}
            max={1}
            step="any"
            value={draft.sampleRate}
            onChange={(e) => set('sampleRate', e.target.value)}
          />
        </label>
        <label className="evaluators-check">
          <input name="evaluator-enabled" type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enabled
        </label>
      </div>
      <KindField draft={draft} choose={choose} judgeAllowed={judgeAllowed} />
      {draft.kind === 'code' ? (
        <label className="datasets-field">
          <span>Function (trace) =&gt; number | {'{ value, comment }'}</span>
          <textarea
            name="evaluator-source"
            className="evaluators-text evaluators-code"
            rows={8}
            spellCheck={false}
            value={draft.source}
            onChange={(e) => set('source', e.target.value)}
          />
        </label>
      ) : (
        <JudgeFields draft={draft} set={set} keys={keys} />
      )}
      <FilterFields draft={draft} set={set} agents={agents} />
      <div className="queues-form-actions">
        {problem && <span className="datasets-note">{problem}</span>}
        {actions}
        <button type="submit" className="btn" disabled={saving || problem !== undefined}>
          {submitLabel}
        </button>
      </div>
      {error && (
        <p className="datasets-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
