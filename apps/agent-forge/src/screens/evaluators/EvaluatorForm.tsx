/**
 * The evaluator form the list's "New evaluator" and the edit view share, one
 * card per section: General (name, enabled, kind), Logic (`code`: the function
 * in a mono editor; `judge`: a model and the rubric) and Sampling (the trace
 * filter - agent, status, name contains - and the sample rate), over a footer
 * that sticks to the bottom of the screen with the save actions. A judge needs
 * a provider key, stored in Studio's settings or set as the provider's env var
 * where Studio runs (judges run with either): without one the judge option is
 * disabled, with a hint that links Settings.
 * A failed save (a taken name is the daemon's 409) shows inline in the footer.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { ProviderKeyStatus } from '../../../shared/wireTypes';
import { ObserveApiError } from '../../observe/observeClient';
import type { NewEvaluator, ObserveAgentRow } from '../../observe/types';
import { Card } from '../../ui/Card';
import { MOCK_PROVIDER, defaultProvider, providerOptions } from '../playground/request';
import { KIND_ICON } from './EvaluatorCard';
import { draftProblem, toNewEvaluator, type EvaluatorDraft } from './evaluatorDraft';

type SetField = <K extends keyof EvaluatorDraft>(field: K, value: EvaluatorDraft[K]) => void;

/** The save failure shown inline: a 409 is a taken name, anything else its message. */
const saveError = (error: unknown): string =>
  error instanceof ObserveApiError && error.status === 409
    ? 'Could not save: an evaluator with that name exists.'
    : `Could not save the evaluator: ${(error as Error).message}`;

/** The providers a judge can run on: a key stored in Settings or the provider's env var (`envKey`) both count. */
const judgeKeys = (keys: readonly ProviderKeyStatus[]): ProviderKeyStatus[] => keys.map((k) => ({ ...k, hasKey: k.hasKey || k.envKey }));

const KINDS: { kind: EvaluatorDraft['kind']; title: string; description: string }[] = [
  { kind: 'code', title: 'Code', description: 'A JavaScript function of the trace returns the score.' },
  { kind: 'judge', title: 'LLM judge', description: 'A model grades the trace against your rubric.' },
];

/** One kind as a radio card: the native radio, the kind icon, its title (the radio's name) and a line on what it does. */
function KindOption({
  option,
  checked,
  disabled,
  describedBy,
  onChoose,
}: {
  option: (typeof KINDS)[number];
  checked: boolean;
  disabled: boolean;
  describedBy?: string;
  onChoose: () => void;
}) {
  const id = useId();
  const Icon = KIND_ICON[option.kind];
  return (
    <label className="ev-kind-option">
      <span className={`ds-card-icon ev-icon ev-icon-${option.kind}`} aria-hidden="true">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span className="ev-kind-text">
        <span className="ev-kind-title" id={`${id}-title`}>
          {option.title}
        </span>
        <span className="ev-kind-desc" id={`${id}-desc`}>
          {option.description}
        </span>
      </span>
      <input
        type="radio"
        name="evaluator-kind"
        value={option.kind}
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-title`}
        aria-describedby={describedBy ?? `${id}-desc`}
        onChange={onChoose}
      />
    </label>
  );
}

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
    <fieldset className="ev-kind">
      <legend className="ev-legend overline">Kind</legend>
      <div className="ev-kind-options">
        {KINDS.map((option) => {
          const blocked = option.kind === 'judge' && !judgeAllowed;
          return (
            <KindOption
              key={option.kind}
              option={option}
              checked={draft.kind === option.kind}
              disabled={blocked}
              describedBy={blocked ? 'evaluator-judge-hint' : undefined}
              onChoose={() => choose(option.kind)}
            />
          );
        })}
      </div>
      {!judgeAllowed && (
        <p id="evaluator-judge-hint" className="ev-hint">
          Add a provider key in <a href="#/settings">Settings</a> to use judge evaluators.
        </p>
      )}
    </fieldset>
  );
}

function GeneralCard({
  draft,
  set,
  choose,
  judgeAllowed,
}: {
  draft: EvaluatorDraft;
  set: SetField;
  choose: (kind: EvaluatorDraft['kind']) => void;
  judgeAllowed: boolean;
}) {
  return (
    <Card title="General" description="What the rule is called, and whether it runs">
      <div className="ev-form-body">
        <div className="ev-row">
          <label className="ds-field ev-grow">
            <span className="ds-field-label">Name</span>
            <input
              className="input"
              name="evaluator-name"
              type="text"
              value={draft.name}
              placeholder="e.g. answered"
              onChange={(e) => set('name', e.target.value)}
            />
          </label>
          <label className="ev-enabled">
            <input
              className="ev-switch"
              name="evaluator-enabled"
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            Enabled
          </label>
        </div>
        <KindField draft={draft} choose={choose} judgeAllowed={judgeAllowed} />
      </div>
    </Card>
  );
}

/** A labelled mono editor surface: the label is its header bar, `tag` a decorative language note. */
function Editor({
  label,
  tag,
  name,
  value,
  placeholder,
  onChange,
}: {
  label: ReactNode;
  tag: string;
  name: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ev-editor">
      <span className="ev-editor-bar">
        <span className="ev-editor-label">{label}</span>
        <span className="ev-editor-tag overline" aria-hidden="true">
          {tag}
        </span>
      </span>
      <textarea
        name={name}
        className="ev-editor-text"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function JudgeFields({ draft, set, keys }: { draft: EvaluatorDraft; set: SetField; keys: readonly ProviderKeyStatus[] }) {
  const options = providerOptions(keys);
  if (draft.provider !== '' && !options.includes(draft.provider)) options.unshift(draft.provider);
  const isMock = draft.provider === MOCK_PROVIDER;
  return (
    <>
      <div className="ev-row">
        <label className="ds-field ev-provider">
          <span className="ds-field-label">Provider</span>
          <select className="select" name="evaluator-provider" value={draft.provider} onChange={(e) => set('provider', e.target.value)}>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="">custom (provider/model)</option>
          </select>
        </label>
        <label className="ds-field ev-grow">
          <span className="ds-field-label">Model</span>
          <input
            className="input"
            name="evaluator-model"
            type="text"
            value={isMock ? '' : draft.model}
            disabled={isMock}
            placeholder={draft.provider === '' ? 'provider/model' : 'model name'}
            onChange={(e) => set('model', e.target.value)}
          />
        </label>
      </div>
      <Editor
        label="Rubric"
        tag="Prompt"
        name="evaluator-rubric"
        value={draft.rubric}
        placeholder="Score 1 when the reply answers the question, 0 otherwise."
        onChange={(value) => set('rubric', value)}
      />
    </>
  );
}

function LogicCard({ draft, set, keys }: { draft: EvaluatorDraft; set: SetField; keys: readonly ProviderKeyStatus[] }) {
  const code = draft.kind === 'code';
  return (
    <Card
      title="Logic"
      description={code ? 'The function every sampled trace is scored by' : 'The model and rubric every sampled trace is graded by'}
    >
      <div className="ev-form-body">
        {code ? (
          <Editor
            label={<>Function (trace) =&gt; number | {'{ value, comment }'}</>}
            tag="JavaScript"
            name="evaluator-source"
            value={draft.source}
            onChange={(value) => set('source', value)}
          />
        ) : (
          <JudgeFields draft={draft} set={set} keys={keys} />
        )}
      </div>
    </Card>
  );
}

function SamplingCard({ draft, set, agents }: { draft: EvaluatorDraft; set: SetField; agents: ObserveAgentRow[] }) {
  const known = agents.some((a) => a.agent_id === draft.agentId);
  return (
    <Card title="Sampling" description="Which finished traces the rule scores">
      <div className="ev-form-body">
        <fieldset className="ev-filter-set">
          <legend className="ev-legend overline">Runs on traces where</legend>
          <div className="ev-row">
            <label className="ds-field ev-select-field">
              <span className="ds-field-label">Agent</span>
              <select className="select" name="evaluator-agent" value={draft.agentId} onChange={(e) => set('agentId', e.target.value)}>
                <option value="">Any agent</option>
                {draft.agentId && !known && <option value={draft.agentId}>{draft.agentId}</option>}
                {agents.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name ?? a.agent_id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label className="ds-field ev-select-field">
              <span className="ds-field-label">Status</span>
              <select
                className="select"
                name="evaluator-status"
                value={draft.status}
                onChange={(e) => set('status', e.target.value as EvaluatorDraft['status'])}
              >
                <option value="">Any status</option>
                <option value="ok">ok</option>
                <option value="error">error</option>
              </select>
            </label>
            <label className="ds-field ev-grow">
              <span className="ds-field-label">Name contains</span>
              <input
                className="input"
                name="evaluator-name-contains"
                type="text"
                value={draft.nameContains}
                onChange={(e) => set('nameContains', e.target.value)}
              />
            </label>
          </div>
        </fieldset>
        <label className="ds-field ev-rate">
          <span className="ds-field-label">Sample rate (0-1)</span>
          <input
            className="input"
            name="evaluator-sample-rate"
            type="number"
            min={0}
            max={1}
            step="any"
            value={draft.sampleRate}
            onChange={(e) => set('sampleRate', e.target.value)}
          />
        </label>
      </div>
    </Card>
  );
}

/** The sticky footer: why the draft can't be saved yet (or the save error), then the actions. */
function FormFooter({
  problem,
  error,
  actions,
  submit,
}: {
  problem: string | undefined;
  error: string | undefined;
  actions: ReactNode;
  submit: ReactNode;
}) {
  return (
    <div className="ev-form-footer">
      <div className="ev-form-status">
        {error ? (
          <p className="datasets-form-error" role="alert">
            {error}
          </p>
        ) : (
          problem && <span className="ev-hint">{problem}</span>
        )}
      </div>
      <div className="ev-form-actions">
        {actions}
        {submit}
      </div>
    </div>
  );
}

interface EvaluatorFormProps {
  /** The form's accessible name. */
  title: string;
  initial: EvaluatorDraft;
  keys: readonly ProviderKeyStatus[];
  agents: ObserveAgentRow[];
  submitLabel: string;
  /** Saves the rule; a rejection shows inline. Resolving `true` resets the form to `initial`. */
  onSubmit: (body: NewEvaluator) => Promise<boolean>;
  /** Extra buttons beside the submit (the edit view's Delete, the new form's Cancel). */
  actions?: ReactNode;
}

/** The create/edit form; it owns the draft, the parent owns the request. */
export function EvaluatorForm({ title, initial, keys, agents, submitLabel, onSubmit, actions }: EvaluatorFormProps) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const set: SetField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));
  const usable = judgeKeys(keys);
  const judgeAllowed = usable.some((k) => k.hasKey) || initial.kind === 'judge';
  const problem = draftProblem(draft);
  // The keys load after the draft is made: a judge with no model typed yet starts on the first keyed provider.
  const choose = (kind: EvaluatorDraft['kind']) =>
    setDraft((d) => (kind === 'judge' && d.kind !== 'judge' && d.model === '' ? { ...d, kind, provider: defaultProvider(usable) } : { ...d, kind }));

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
    <form className="ev-form" aria-label={title} onSubmit={(e) => void submit(e)}>
      <GeneralCard draft={draft} set={set} choose={choose} judgeAllowed={judgeAllowed} />
      <LogicCard draft={draft} set={set} keys={usable} />
      <SamplingCard draft={draft} set={set} agents={agents} />
      <FormFooter
        problem={problem}
        error={error}
        actions={actions}
        submit={
          <button type="submit" className="btn btn-primary" disabled={saving || problem !== undefined}>
            {submitLabel}
          </button>
        }
      />
    </form>
  );
}
