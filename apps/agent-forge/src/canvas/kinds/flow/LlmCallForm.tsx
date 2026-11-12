/**
 * `LlmCallForm` — the `llmCall` step's Inspector body: the prompt
 * (`{{var}}` placeholders), an optional model (catalog picker with an
 * "Agent's model" unset option), temperature, max tokens and the output
 * variable.
 */
import { useState, type ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Select, Textarea } from '../../../ui/controls';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import { useCatalog } from '../../useCatalog';
import { modelGroups } from '../../modelGroups';
import type { KindFieldsProps } from '../index';
import { OutputVariableField } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The select value meaning "no step model — the agent's model applies". */
const AGENT_MODEL = '__agent__';
/** The select value meaning "type a provider/model by hand". */
const OTHER = '__other__';

type CatalogModel = { id: string; provider: string; available: boolean };

/** The catalog `Select` or the free-text `Input`, per the picker's state. */
function ModelInput({
  value,
  models,
  loading,
  freeText,
  onSelect,
  onText,
}: {
  value: string;
  models: CatalogModel[] | undefined;
  loading: boolean;
  freeText: boolean;
  onSelect(e: ChangeEvent<HTMLSelectElement>): void;
  onText(e: ChangeEvent<HTMLInputElement>): void;
}): JSX.Element {
  if (loading) {
    return <Select options={[{ value: '', label: 'Loading models…' }]} value="" disabled />;
  }
  if (freeText) {
    return <Input className="mono" value={value} placeholder="provider/model" onChange={onText} />;
  }
  return (
    <Select
      value={value === '' ? AGENT_MODEL : value}
      options={[
        { value: AGENT_MODEL, label: "Agent's model" },
        { value: OTHER, label: 'Other…' },
      ]}
      groups={models === undefined ? undefined : modelGroups(models)}
      onChange={onSelect}
    />
  );
}

/** The optional model control: unset → the agent's model, a catalog pick, or free text. */
function ModelField({
  id,
  step,
  patch,
}: {
  id: string;
  step: FlowProps['node']['data']['step'];
  patch(p: Record<string, unknown>): void;
}): JSX.Element {
  const catalog = useCatalog('models');
  const models = catalog.data;
  const value = typeof step.model === 'string' ? step.model : '';
  const inCatalog = models !== undefined && value !== '' && models.some((m) => m.id === value);
  const [other, setOther] = useState(value !== '' && models !== undefined && !inCatalog);

  const onSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (next === OTHER) {
      setOther(true);
      patch({ model: undefined });
      return;
    }
    setOther(false);
    patch({ model: next === AGENT_MODEL ? undefined : next });
  };

  const onText = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    patch({ model: text === '' ? undefined : text });
  };

  const freeText = other || (models !== undefined && !inCatalog && value !== '');
  return (
    <Field id={id} label="Model" hint="Leave unset to use the agent's model.">
      <ModelInput
        value={value}
        models={models}
        loading={catalog.loading}
        freeText={freeText}
        onSelect={onSelect}
        onText={onText}
      />
    </Field>
  );
}

/** The `llmCall` step's fields. */
export function LlmCallForm({ node, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  const prompt = typeof step.prompt === 'string' ? step.prompt : '';
  const temperature = typeof step.temperature === 'number' ? step.temperature : undefined;
  const maxTokens = typeof step.maxTokens === 'number' ? step.maxTokens : undefined;
  return (
    <>
      <Field
        id={`${base}-prompt`}
        label="Prompt"
        required={prompt === ''}
        error={prompt === '' ? 'Required' : undefined}
        hint="Use {{variable}} or {{variable.path}}."
      >
        <Textarea
          className="mono"
          rows={8}
          value={prompt}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patch({ prompt: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <ModelField id={`${base}-model`} step={step} patch={patch} />
      <OptionalNumberField
        id={`${base}-temperature`}
        label="Temperature"
        value={temperature}
        min={0}
        max={2}
        step={0.1}
        onChange={(next) => patch({ temperature: next })}
      />
      <OptionalNumberField
        id={`${base}-maxTokens`}
        label="Max tokens"
        value={maxTokens}
        min={1}
        integer
        onChange={(next) => patch({ maxTokens: next })}
      />
      <OutputVariableField id={`${base}-output`} step={step} patch={patch} />
    </>
  );
}
