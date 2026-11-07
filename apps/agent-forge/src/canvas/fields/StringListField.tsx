/**
 * `StringListField` edits a `string[]` spec value as chips plus one text
 * input: Enter or a comma adds the draft (duplicates are ignored), each
 * chip has a labelled remove button, and removing the last chip emits
 * `undefined` rather than `[]`.
 */
import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import './fields.css';

/** Props for {@link StringListField}. */
export interface StringListFieldProps {
  /** Control id (`node-<kind>-<field>`). */
  id: string;
  /** Field label text. */
  label: string;
  value: string[] | undefined;
  onChange(value: string[] | undefined): void;
  /** Input placeholder (e.g. 'Add a model id'). */
  placeholder?: string;
  /** Muted help under the control. */
  help?: string;
  /** Per-item validation; the returned message becomes the field error and the item is not added. */
  validateItem?(item: string): string | undefined;
  /**
   * A `<datalist>` of completions for the draft input (id `<id>-suggestions`),
   * e.g. the owner's tool names for a permission rule's tool list.
   */
  suggestions?: string[];
  /** An external error that wins over the item checks — for "the list itself is invalid" rules like a required non-empty list. */
  error?: string;
}

/**
 * The chip-list control string arrays (`fallbackModels`, `args`,
 * `include`/`exclude` lists) use across the node inspectors.
 */
export function StringListField({
  id,
  label,
  value,
  onChange,
  placeholder,
  help,
  validateItem,
  suggestions,
  error,
}: StringListFieldProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [itemError, setItemError] = useState<string | undefined>();
  const items = value ?? [];
  const listId = `${id}-suggestions`;

  const emit = (next: string[]) => {
    onChange(next.length === 0 ? undefined : next);
  };

  /** Adds `item` (trimmed) when it is new and valid; answers whether it was added. */
  const addItem = (item: string): boolean => {
    const trimmed = item.trim();
    if (trimmed === '') return false;
    if (items.includes(trimmed)) return true; // duplicates are ignored, silently
    const problem = validateItem?.(trimmed);
    if (problem !== undefined) {
      setItemError(problem);
      return false;
    }
    setItemError(undefined);
    emit([...items, trimmed]);
    return true;
  };

  /**
   * The input's change handler: a comma splits the text into new items
   * (validated one by one) and keeps whatever could not be added, plus
   * the tail after the last comma, as the draft.
   */
  const onText = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    if (!text.includes(',')) {
      setDraft(text);
      return;
    }
    const parts = text.split(',');
    const tail = parts.pop()!;
    const next = [...items];
    let problem: string | undefined;
    let consumed = 0;
    for (; consumed < parts.length; consumed++) {
      const trimmed = parts[consumed].trim();
      if (trimmed === '' || next.includes(trimmed)) continue;
      problem = validateItem?.(trimmed);
      if (problem !== undefined) break;
      next.push(trimmed);
    }
    setItemError(problem);
    if (next.length !== items.length) emit(next);
    setDraft([...parts.slice(consumed), tail].join(','));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (addItem(draft)) setDraft('');
  };

  const remove = (item: string) => {
    emit(items.filter((existing) => existing !== item));
  };

  return (
    <Field id={id} label={label} error={error ?? itemError} hint={help}>
      <div className="stringlist">
        {items.map((item) => (
          <span key={item} className="chip">
            {item}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${item}`}
              onClick={() => remove(item)}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </span>
        ))}
        <Input
          value={draft}
          onChange={onText}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          list={suggestions === undefined ? undefined : listId}
        />
        {suggestions !== undefined && (
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        )}
      </div>
    </Field>
  );
}
