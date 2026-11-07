/**
 * `JsonField` edits an arbitrary JSON spec value as a monospaced
 * textarea: the draft is validated on blur (JSON parse, then the
 * optional `check`), and only a valid document reaches `onChange`.
 * Invalid text stays in the draft with the error shown below it.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../ui/Field';
import { Textarea } from '../../ui/controls';
import { useSyncedDraft } from './useSyncedDraft';
import './fields.css';

/** Props for {@link JsonField}. */
export interface JsonFieldProps {
  /** Control id (`node-<kind>-<field>`). */
  id: string;
  /** Field label text. */
  label: string;
  value: unknown;
  onChange(value: unknown): void;
  /** Muted help under the control. */
  help?: string;
  /** Textarea row count (default 6). */
  rows?: number;
  /** Extra validation after a successful parse; the returned message becomes the field error and the value is not emitted. */
  check?(value: unknown): string | undefined;
}

/** `value` as the textarea shows it: pretty-printed JSON, empty for `undefined`. */
function textOf(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/**
 * The free-form JSON control `options`, `inputJsonSchema` and "other
 * settings" maps use across the node inspectors.
 */
export function JsonField({ id, label, value, onChange, help, rows = 6, check }: JsonFieldProps): JSX.Element {
  const { draft, setDraft, error, setError, emit } = useSyncedDraft<unknown>(value, textOf, onChange);

  const onBlur = () => {
    const text = draft.trim();
    if (text === '') {
      emit(undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      setError(`This is not valid JSON: ${(parseError as Error).message}`);
      return;
    }
    const problem = check?.(parsed);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    emit(parsed);
  };

  return (
    <Field id={id} label={label} error={error} hint={help}>
      <Textarea
        value={draft}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
        onBlur={onBlur}
        rows={rows}
        spellCheck={false}
      />
    </Field>
  );
}
