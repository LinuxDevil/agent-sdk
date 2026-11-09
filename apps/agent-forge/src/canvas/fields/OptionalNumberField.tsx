/**
 * `OptionalNumberField` edits an optional numeric spec value: a
 * `type="number"` input whose draft is validated per keystroke (whole
 * number, `min`/`max` range). Invalid text stays in the draft and is
 * never emitted; an empty input emits `undefined`.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { useSyncedDraft } from './useSyncedDraft';
import './fields.css';

function numberText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Props for {@link OptionalNumberField}. */
export interface OptionalNumberFieldProps {
  /** Control id (`node-<kind>-<field>`). */
  id: string;
  /** Field label text. */
  label: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
  min?: number;
  max?: number;
  /** Native `step` attribute (e.g. `0.1` for temperature). */
  step?: number;
  /** Non-integers show 'Enter a whole number'. */
  integer?: boolean;
  /** Muted help under the control. */
  help?: string;
  /** Unit suffix drawn after the input ('ms', 'tokens'). */
  unit?: string;
  /** Spec-path suffix for `data-field-path` (Inspector Problems focus, C19). */
  fieldPath?: string;
}

/** `n`'s range error message for the bounds that are actually set. */
function rangeError(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `Enter a number from ${min} to ${max}`;
  if (min !== undefined) return `Enter ${min} or more`;
  return `Enter ${max} or less`;
}

/** `text`'s error under the field's rules, or `undefined` when it is an emittable number. */
function validate(
  text: string,
  props: Pick<OptionalNumberFieldProps, 'min' | 'max' | 'integer'>,
): string | undefined {
  const num = Number(text);
  if (!Number.isFinite(num)) return 'Enter a number';
  if (props.integer === true && !Number.isInteger(num)) return 'Enter a whole number';
  if ((props.min !== undefined && num < props.min) || (props.max !== undefined && num > props.max)) {
    return rangeError(props.min, props.max);
  }
  return undefined;
}

/**
 * The nullable-number control `temperature`, `topP`, `maxOutputTokens`,
 * `budgetTokens` and friends use across the node inspectors.
 */
export function OptionalNumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  integer,
  help,
  unit,
  fieldPath,
}: OptionalNumberFieldProps): JSX.Element {
  const { draft, setDraft, error, setError, emit } = useSyncedDraft(value, numberText, onChange);

  const onText = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    if (text.trim() === '') {
      emit(undefined);
      return;
    }
    const problem = validate(text, { min, max, integer });
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    emit(Number(text));
  };

  return (
    <Field id={id} label={label} error={error} hint={help} fieldPath={fieldPath}>
      <div className="numfield-row">
        <Input type="number" value={draft} onChange={onText} min={min} max={max} step={step} />
        {unit !== undefined ? <span className="field-unit">{unit}</span> : null}
      </div>
    </Field>
  );
}
