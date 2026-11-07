/**
 * `ModelPicker` — the agent Inspector's model control (C03). The catalog
 * (`useCatalog('models')`) fills a grouped select — one `<optgroup>` per
 * provider, unavailable models suffixed "(no key)" — plus an "Other…"
 * option that switches to a free-text input. A value the catalog does not
 * know opens the same input with a "still be tried" hint. Loading shows a
 * disabled select; a failed fetch falls back to the input plus a Retry
 * button that calls `refreshCatalog('models')`.
 */
import { useState, type ChangeEvent, type ChangeEventHandler } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Select, type SelectGroup } from '../../../ui/controls';
import { refreshCatalog, useCatalog } from '../../useCatalog';
import { AGENT_MODEL_PATTERN } from '../../../graph/v2/kinds/agent';
import '../../fields/fields.css';

/** Props for {@link ModelPicker}. */
export interface ModelPickerProps {
  /** Control id (`node-agent-model`). */
  id: string;
  /** `fields.model`: 'provider/model', or `undefined`/'' when unset. */
  value: string | undefined;
  /** Emits the picked or typed 'provider/model'; `undefined` when the input is cleared. */
  onChange(value: string | undefined): void;
}

/** The inline message for a non-empty value that is not 'provider/model'. */
export const MODEL_ID_ERROR = 'Use provider/model, e.g. anthropic/claude-sonnet-5-5';

/** The select value of the "Other…" option (no catalog id can equal it). */
const OTHER = '__other__';

/** One `<optgroup>` per provider, alphabetically; an unavailable model is labelled '(no key)'. */
function groupsOf(models: { id: string; provider: string; available: boolean }[]): SelectGroup[] {
  const providers = [...new Set(models.map((m) => m.provider))].sort();
  return providers.map((provider) => ({
    label: provider,
    options: models
      .filter((m) => m.provider === provider)
      .map((m) => ({ value: m.id, label: m.available ? m.id : `${m.id} (no key)` })),
  }));
}

/** The field error: a required/pattern problem on the value first, else the catalog's failure. */
function errorOf(value: string | undefined, catalogError: string | undefined): string | undefined {
  if (value === undefined || value === '') return 'Required';
  if (!AGENT_MODEL_PATTERN.test(value)) return MODEL_ID_ERROR;
  return catalogError;
}

/** The free-text half of the picker: an input, plus a Retry button while the catalog is in its error state. */
function FreeText({
  value,
  catalogError,
  onChange,
}: {
  value: string | undefined;
  catalogError: string | undefined;
  onChange: ChangeEventHandler<HTMLInputElement>;
}): JSX.Element {
  return (
    <div className="modelpicker-row">
      <Input value={value ?? ''} onChange={onChange} placeholder="provider/model" />
      {catalogError !== undefined ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshCatalog('models')}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** The model `Select`/`Input` described above. */
export function ModelPicker({ id, value, onChange }: ModelPickerProps): JSX.Element {
  const catalog = useCatalog('models');
  const [other, setOther] = useState(false);
  const models = catalog.data;
  const inCatalog = models !== undefined && value !== undefined && value !== '' && models.some((m) => m.id === value);
  const freeText = catalog.error !== undefined || other || (models !== undefined && !inCatalog && value !== undefined && value !== '');

  const onSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value === OTHER) {
      setOther(true);
      onChange(undefined);
      return;
    }
    onChange(event.target.value);
  };

  const onText = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    if (text === '') {
      setOther(false);
      onChange(undefined);
      return;
    }
    onChange(text);
  };

  const hint =
    freeText && !inCatalog && catalog.error === undefined
      ? 'Not in the catalog. It will still be tried.'
      : 'Models without a key in Settings are marked (no key).';

  return (
    <Field id={id} label="Model" required error={errorOf(value, catalog.error)} hint={hint}>
      {catalog.loading ? (
        <Select options={[{ value: '', label: 'Loading models…' }]} value="" disabled />
      ) : freeText ? (
        <FreeText value={value} catalogError={catalog.error} onChange={onText} />
      ) : (
        <Select
          value={value ?? ''}
          placeholder="Pick a model"
          groups={groupsOf(models ?? [])}
          options={[{ value: OTHER, label: 'Other…' }]}
          onChange={onSelect}
        />
      )}
    </Field>
  );
}
