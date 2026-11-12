/**
 * `ValueField` — the shared "value" control for `setVariable`, `end` and
 * `return`: a mono `Input` for text (a leading `$` reads another variable)
 * with a "JSON value" toggle that switches to the kit's {@link JsonField}
 * for arbitrary JSON. Writes land on `step[field]` through `patch`;
 * `undefined` deletes the key.
 */
import { useState, type ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { JsonField } from '../../fields/JsonField';
import { useSyncedDraft } from '../../fields/useSyncedDraft';
import type { StepRecord } from './flowForm';
import './flow.css';

/** Props for {@link ValueField}. */
export interface ValueFieldProps {
  /** Control id (`node-flow-<field>`). */
  id: string;
  /** Step field written (default `value`). */
  field?: string;
  step: StepRecord;
  patch(patch: Record<string, unknown>): void;
  label?: string;
  help?: string;
}

/** `value` as the text input shows it: strings verbatim, `undefined` empty, anything else compact JSON. */
function textOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The text/JSON toggle for one step value. The mode follows the value's
 * shape (string → text, anything else → JSON) until the user flips it.
 */
export function ValueField({ id, field = 'value', step, patch, label = 'Value', help }: ValueFieldProps): JSX.Element {
  const value = step[field];
  const [json, setJson] = useState(() => value !== undefined && typeof value !== 'string');
  const { draft, setDraft, emit } = useSyncedDraft<unknown>(value, textOf, (next) => patch({ [field]: next }));

  const toggle = () => {
    setJson(!json);
    setDraft(json ? textOf(value) : JSON.stringify(value ?? null, null, 2));
  };

  if (json) {
    return (
      <>
        <JsonField id={id} label={label} value={value} rows={4} help={help} onChange={(next) => patch({ [field]: next })} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggle}>
          Text value
        </button>
      </>
    );
  }

  return (
    <Field id={id} label={label} hint={help}>
      <div className="modelpicker-row">
        <Input
          className="mono"
          value={draft}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={() => emit(draft === '' ? undefined : draft)}
          placeholder="$variable or text"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggle}>
          JSON value
        </button>
      </div>
    </Field>
  );
}
