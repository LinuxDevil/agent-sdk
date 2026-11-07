import { useState, type KeyboardEvent } from 'react';
import { Trash2 } from 'lucide-react';

import { Input } from '../controls';

// fallow-ignore-next-line circular-dependency -- container fields recurse into SchemaNode, which dispatches back through FIELD_RENDERERS; the recursion is inherent to schema dispatch and safe at render time.
import { fieldLabel, SchemaNode, type FieldRendererProps } from './fields';
import { pathKey, resolveRef } from './schemaPath';
import type { JsonSchema } from './types';
import { usePendingFocus } from './usePendingFocus';
import { defaultForSchema } from './variants';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The two key-edit refusals: empty and duplicate (exact copy). */
function keyError(key: string, existing: Set<string>): string | undefined {
  if (key === '') return 'Key can’t be empty.';
  if (existing.has(key)) return `“${key}” is already used.`;
  return undefined;
}

/**
 * The record-map renderer: one row per key (`{label} key {n}` input + the
 * `additionalProperties` field at `[...path, key]` + a remove button), plus a
 * new-key row. Key edits commit on blur — empty or duplicate keys are refused
 * with an error and no commit; a rename rebuilds the object with the new key
 * in the old position.
 */
export function RecordField({ root, schema, path, value, required, ctx }: FieldRendererProps): JSX.Element {
  const label = fieldLabel(schema, path, ctx);
  const obj = isRecord(value) ? value : {};
  const entries = Object.entries(obj);
  const keys = new Set(entries.map(([k]) => k));
  const valueSchema: JsonSchema =
    typeof schema.additionalProperties === 'object'
      ? resolveRef(root, schema.additionalProperties)
      : {};
  const error = ctx.errors[pathKey(path)];

  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [draftErrors, setDraftErrors] = useState<Record<number, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newKeyError, setNewKeyError] = useState<string | undefined>(undefined);
  const { ref: containerRef, focus } = usePendingFocus<HTMLDivElement>();

  const clearDraft = (index: number) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setDraftErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  /** Renames the key at `index` to `next`, keeping its value and position. */
  const commitKey = (index: number, next: string) => {
    const old = entries[index]?.[0];
    if (old == null || next === old) {
      clearDraft(index);
      return;
    }
    const message = keyError(next, keys);
    if (message != null) {
      setDraftErrors((prev) => ({ ...prev, [index]: message }));
      return;
    }
    const rebuilt: Record<string, unknown> = {};
    entries.forEach(([k, v], i) => {
      rebuilt[i === index ? next : k] = v;
    });
    clearDraft(index);
    ctx.onChange(path, rebuilt);
  };

  const addEntry = () => {
    const key = newKey.trim();
    const message = keyError(key, keys);
    if (message != null) {
      setNewKeyError(message);
      return;
    }
    setNewKey('');
    setNewKeyError(undefined);
    ctx.onChange(path, { ...obj, [key]: defaultForSchema(root, valueSchema) });
  };

  const removeEntry = (index: number, key: string) => {
    const next = { ...obj };
    delete next[key];
    setDrafts({});
    setDraftErrors({});
    focus(
      index < entries.length - 1
        ? `input[aria-label="${label} key ${index + 1}"]`
        : `input[aria-label="New ${label} key"]`,
    );
    ctx.onChange(path, Object.keys(next).length === 0 && !required ? undefined : next);
  };

  const onNewKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addEntry();
    }
  };

  return (
    <div className="field" data-path={pathKey(path)} ref={containerRef}>
      <div className="field-label">{label}</div>
      <ul className="schema-record">
        {entries.map(([key, v], i) => (
          <li className="schema-record-row" key={key}>
            <Input
              aria-label={`${label} key ${i + 1}`}
              value={drafts[i] ?? key}
              disabled={ctx.readOnly}
              invalid={draftErrors[i] != null}
              onChange={(e) => {
                setDrafts((prev) => ({ ...prev, [i]: e.target.value }));
                setDraftErrors((prev) => {
                  const next = { ...prev };
                  delete next[i];
                  return next;
                });
              }}
              onBlur={() => commitKey(i, (drafts[i] ?? key).trim())}
            />
            <div className="schema-record-value">
              <SchemaNode
                root={root}
                schema={valueSchema}
                path={[...path, key]}
                value={v}
                required={false}
                ctx={ctx}
              />
              {draftErrors[i] != null ? <p className="hint field-error">{draftErrors[i]}</p> : null}
            </div>
            {ctx.readOnly ? null : (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm btn-danger-text"
                aria-label={`Remove ${key}`}
                onClick={() => removeEntry(i, key)}
              >
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {ctx.readOnly ? null : (
        <div className="schema-record-add">
          <Input
            placeholder="New key"
            aria-label={`New ${label} key`}
            value={newKey}
            invalid={newKeyError != null}
            onChange={(e) => {
              setNewKey(e.target.value);
              setNewKeyError(undefined);
            }}
            onKeyDown={onNewKeyDown}
          />
          <button type="button" className="btn btn-sm" onClick={addEntry}>
            Add
          </button>
        </div>
      )}
      {newKeyError != null ? <p className="hint field-error">{newKeyError}</p> : null}
      {error != null ? <p className="hint field-error">{error}</p> : null}
    </div>
  );
}
