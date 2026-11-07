/**
 * `SecretRefField` edits a spec v2 `SecretRef | string` value: a kind
 * select (`{ env }`, `{ secret }`, or - only with `allowPlain` - a literal
 * string) plus one text input for the name/value. Invalid names stay in
 * the draft and are never emitted; an empty input emits `undefined`.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Field } from '../../ui/Field';
import { Input, Select } from '../../ui/controls';
import type { SecretRef } from '../../../shared/wireTypes';
import './fields.css';

type SecretMode = 'env' | 'secret' | 'plain';

/** Props for {@link SecretRefField}. */
export interface SecretRefFieldProps {
  /** Control id (`node-<kind>-<field>`); the mode select takes `<id>-mode`. */
  id: string;
  /** Field label text. */
  label: string;
  value: SecretRef | string | undefined;
  onChange(value: SecretRef | string | undefined): void;
  /** Adds the 'Plain text' kind for specs that also accept a literal string. */
  allowPlain?: boolean;
  /** Muted help under the control (hidden behind the plain-text warning in plain mode). */
  help?: string;
  /** Empty input shows 'Required' (and still emits `undefined`). */
  required?: boolean;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** D13's secret-name rule fallback - `SECRET_NAME_RE` lives server-side (server/secretsStore.ts). */
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ENV_NAME_ERROR = 'Use capitals, digits and underscores, e.g. GITHUB_TOKEN';
const SECRET_NAME_ERROR = 'Use letters, digits, dot, dash or underscore';
const PLAIN_WARNING = 'Plain values are saved in the YAML file. Prefer a secret.';

/** The kind a value represents: `{ env }`, `{ secret }` or a plain string (`'env'` when unset). */
function modeOf(value: SecretRef | string | undefined): SecretMode {
  if (typeof value === 'string') return 'plain';
  if (value !== undefined && 'secret' in value) return 'secret';
  return 'env';
}

/** The text the single input shows for `value` (env name, secret name or literal). */
function textOf(value: SecretRef | string | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return 'env' in value ? value.env : value.secret;
}

/** `text`'s error under `mode`'s rule, or `undefined` when it is a valid name/value. */
function validate(mode: SecretMode, text: string): string | undefined {
  if (mode === 'env') return ENV_NAME_RE.test(text) ? undefined : ENV_NAME_ERROR;
  if (mode === 'secret') return SECRET_NAME_RE.test(text) ? undefined : SECRET_NAME_ERROR;
  return undefined;
}

/** The emitted value for a valid `text` under `mode`. */
function valueOf(mode: SecretMode, text: string): SecretRef | string {
  if (mode === 'env') return { env: text };
  if (mode === 'secret') return { secret: text };
  return text;
}

const MODE_OPTIONS: { value: SecretMode; label: string; placeholder: string }[] = [
  { value: 'env', label: 'Environment variable', placeholder: 'GITHUB_TOKEN' },
  { value: 'secret', label: 'Studio secret', placeholder: 'Secret name' },
  { value: 'plain', label: 'Plain text', placeholder: 'Value' },
];

/**
 * The secret-reference control MCP servers, triggers, integrations and
 * remote subagents use wherever a spec holds `{ env }` / `{ secret }` (or
 * a literal string with `allowPlain`).
 */
export function SecretRefField({
  id,
  label,
  value,
  onChange,
  allowPlain = false,
  help,
  required = false,
}: SecretRefFieldProps): JSX.Element {
  const [pickedMode, setPickedMode] = useState<SecretMode | undefined>();
  const [draft, setDraft] = useState(() => textOf(value));
  const [error, setError] = useState<string | undefined>();
  // The last value this field emitted, so an external change can be told
  // apart from the echo of our own onChange (which must not clobber the
  // draft or the picked mode).
  const emitted = useRef<SecretRef | string | undefined>(value);
  useEffect(() => {
    if (value === emitted.current) return;
    setPickedMode(undefined);
    setDraft(textOf(value));
    setError(undefined);
  }, [value]);

  const mode = pickedMode ?? modeOf(value);

  const emit = (next: SecretRef | string | undefined) => {
    emitted.current = next;
    onChange(next);
  };

  const onText = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    if (text === '') {
      setError(required ? 'Required' : undefined);
      emit(undefined);
      return;
    }
    const problem = validate(mode, text);
    setError(problem);
    if (problem === undefined) emit(valueOf(mode, text));
  };

  const onMode = (event: ChangeEvent<HTMLSelectElement>) => {
    setPickedMode(event.target.value as SecretMode);
    setDraft('');
    setError(required ? 'Required' : undefined);
    emit(undefined);
  };

  const options = MODE_OPTIONS.filter((option) => option.value !== 'plain' || allowPlain || mode === 'plain').map(
    ({ value: optionValue, label: optionLabel }) => ({ value: optionValue, label: optionLabel }),
  );
  const placeholder = MODE_OPTIONS.find((option) => option.value === mode)?.placeholder;

  return (
    <Field
      id={id}
      label={label}
      error={error}
      hint={mode === 'plain' ? <span className="field-warning">{PLAIN_WARNING}</span> : help}
      required={required}
    >
      <div className="secretref-row">
        <Select
          id={`${id}-mode`}
          aria-label={`${label} kind`}
          options={options}
          value={mode}
          onChange={onMode}
        />
        <Input value={draft} onChange={onText} placeholder={placeholder} />
      </div>
    </Field>
  );
}
