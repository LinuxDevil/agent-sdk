/**
 * `ChoiceField` edits a `T | undefined` spec value as a select: with
 * `allowUnset` an extra first option (`unsetLabel`, 'Default' when not
 * given) maps to `undefined`. Option values are positional, so any string
 * - including '' - is a valid `T`.
 */
import type { ChangeEvent, ReactNode } from 'react';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/controls';
import './fields.css';

/** Props for {@link ChoiceField}. */
export interface ChoiceFieldProps<T extends string> {
  /** Control id (`node-<kind>-<field>`). */
  id: string;
  /** Field label text. */
  label: string;
  value: T | undefined;
  /** Choices in order; each `value` is a `T`, each `label` its display text. `disabled` greys the option out and `title` says why. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange(value: T | undefined): void;
  /** Adds a first option that selects `undefined`. */
  allowUnset?: boolean;
  /** The unset option's text (default 'Default'). */
  unsetLabel?: string;
  /** Muted help under the control. */
  help?: ReactNode;
  /** Danger text under the control; marks it `aria-invalid`. */
  error?: string;
  /** Draws the required marker on the label. */
  required?: boolean;
  /** Spec-path suffix for `data-field-path` (Inspector Problems focus, C19). */
  fieldPath?: string;
}

/** The select's internal value for `undefined` (option values are their 1-based index). */
const UNSET = '0';

/**
 * The fixed-choice control approval modes, reasoning levels, transport
 * kinds and filter presets use across the node inspectors.
 */
export function ChoiceField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  allowUnset = false,
  unsetLabel = 'Default',
  help,
  error,
  required = false,
  fieldPath,
}: ChoiceFieldProps<T>): JSX.Element {
  const selected = value === undefined ? UNSET : String(options.findIndex((option) => option.value === value) + 1);
  const selectOptions = [
    ...(allowUnset ? [{ value: UNSET, label: unsetLabel }] : []),
    ...options.map((option, index) => ({
      value: String(index + 1),
      label: option.label,
      disabled: option.disabled,
      title: option.title,
    })),
  ];

  const onSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const index = Number(event.target.value);
    onChange(index === 0 ? undefined : options[index - 1].value);
  };

  return (
    <Field id={id} label={label} hint={help} error={error} required={required} fieldPath={fieldPath}>
      <Select options={selectOptions} value={selected} onChange={onSelect} />
    </Field>
  );
}
