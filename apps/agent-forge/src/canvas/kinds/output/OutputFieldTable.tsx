/**
 * `OutputFieldTable` edits the top-level `properties`/`required` of an
 * output node's JSON Schema as one row per field: name, type, required,
 * description and a remove button, plus an 'Add field' button. Every edit
 * emits a whole new `jsonSchema` object (other keys like
 * `additionalProperties` pass through untouched); `properties` order is
 * preserved on rename by rebuilding the record key-by-key.
 *
 * Rows whose property the table cannot show — a missing `type` or a list
 * of types — render read-only with a hint to use the JSON editor below,
 * so nothing is silently rewritten. A field name commits on blur or
 * Enter (not per keystroke) so a name that is mid-typing can pass through
 * values that are taken or malformed.
 */
import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Checkbox, Input, Select, type SelectOption } from '../../../ui/controls';
import './output.css';

/** Props for {@link OutputFieldTable}. */
export interface OutputFieldTableProps {
  /** The schema being edited; only `properties` and `required` are touched. */
  jsonSchema: Record<string, unknown>;
  /** Emits the next `jsonSchema` after a table edit. */
  onChange(jsonSchema: Record<string, unknown>): void;
}

/** The primitive types the Type select offers, in display order. */
const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const TYPE_OPTIONS: SelectOption[] = FIELD_TYPES.map((type) => ({ value: type, label: type }));

/** The field-name rule the table enforces before a rename commits. */
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `schema.properties` when it is a plain object, else `{}`. */
function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

/** The string entries of `schema.required` (non-strings cannot name a property). */
function requiredOf(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];
}

/** The row's type when the property is a single-type schema the table can edit. */
function editableType(prop: unknown): FieldType | undefined {
  if (!isRecord(prop) || typeof prop.type !== 'string') return undefined;
  return (FIELD_TYPES as readonly string[]).includes(prop.type) ? (prop.type as FieldType) : undefined;
}

/** Human text for a row the table cannot edit: the type list, `any`, or the raw type. */
function typeText(prop: unknown): string {
  if (isRecord(prop)) {
    if (Array.isArray(prop.type)) return prop.type.map(String).join(' | ');
    if (typeof prop.type === 'string') return prop.type;
  }
  return 'any';
}

/** The property's `description` when it is a string, else `''`. */
function descriptionOf(prop: unknown): string {
  return isRecord(prop) && typeof prop.description === 'string' ? prop.description : '';
}

/**
 * The next `jsonSchema`: `properties`/`required` replaced, every other key
 * (`additionalProperties`, `description`, …) carried over. `required` is
 * re-emitted only while non-empty and only naming declared properties, so
 * the table never leaves a dangling required entry behind.
 */
function emit(
  schema: Record<string, unknown>,
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...schema, properties };
  const kept = required.filter((name) => name in properties);
  if (kept.length === 0) delete next.required;
  else next.required = kept;
  return next;
}

/** Smallest free `field_<n>` name (n ≥ 1) for 'Add field'. */
function nextFieldName(properties: Record<string, unknown>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `field_${n}`;
    if (!(candidate in properties)) return candidate;
  }
}

/** Why a draft field name cannot commit, or `undefined` when it can. */
function nameProblem(draft: string, name: string, properties: Record<string, unknown>): string | undefined {
  if (draft === name) return undefined;
  if (draft.trim() === '') return 'The field needs a name';
  if (!FIELD_NAME_PATTERN.test(draft)) return 'Use letters, digits and underscores';
  if (draft in properties) return 'Another field uses this name';
  return undefined;
}

interface RowHandlers {
  onRename(oldName: string, newName: string): void;
  onType(name: string, type: FieldType): void;
  onRequired(name: string, on: boolean): void;
  onDescription(name: string, text: string): void;
  onRemove(name: string): void;
}

/** One editable field row; `key={name}` remounts it after a rename so the draft resets. */
function EditableRow({
  name,
  prop,
  required,
  type,
  properties,
  handlers,
}: {
  name: string;
  prop: unknown;
  required: boolean;
  type: FieldType;
  properties: Record<string, unknown>;
  handlers: RowHandlers;
}): JSX.Element {
  const [draft, setDraft] = useState(name);
  const problem = nameProblem(draft, name, properties);
  // An invalid draft stays put with its error (Escape reverts) — resetting
  // to `name` here would hide the problem before the user can fix it.
  const commit = () => {
    if (problem === undefined && draft !== name) handlers.onRename(name, draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') setDraft(name);
  };
  return (
    <div className="output-field-row">
      <div className="output-field-head">
        <Input
          className="output-field-name"
          value={draft}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          aria-label={`Field ${name} name`}
          aria-invalid={problem !== undefined || undefined}
        />
        <Select
          className="output-field-type"
          options={TYPE_OPTIONS}
          value={type}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            handlers.onType(name, event.target.value as FieldType)
          }
          aria-label={`Field ${name} type`}
        />
        <Checkbox
          className="output-field-required"
          label="Required"
          checked={required}
          onChange={(event: ChangeEvent<HTMLInputElement>) => handlers.onRequired(name, event.target.checked)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm output-field-remove"
          aria-label={`Remove field ${name}`}
          onClick={() => handlers.onRemove(name)}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <Input
        className="output-field-desc"
        value={descriptionOf(prop)}
        placeholder="Description"
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          handlers.onDescription(name, event.target.value)
        }
        aria-label={`Field ${name} description`}
      />
      {problem !== undefined && <p className="hint field-error">{problem}</p>}
    </div>
  );
}

/** A property whose shape the table cannot edit: name, raw type, and the JSON hint. */
function ReadOnlyRow({ name, prop }: { name: string; prop: unknown }): JSX.Element {
  return (
    <div className="output-field-row output-field-readonly">
      <span className="output-field-name-text">{name}</span>
      <code className="output-field-type-text">{typeText(prop)}</code>
      <span className="hint">Edit this field in the JSON below.</span>
    </div>
  );
}

/** The field table described above. */
export function OutputFieldTable({ jsonSchema, onChange }: OutputFieldTableProps): JSX.Element {
  const properties = propertiesOf(jsonSchema);
  const required = requiredOf(jsonSchema);
  const names = Object.keys(properties);

  const commit = (nextProperties: Record<string, unknown>, nextRequired: string[]) => {
    onChange(emit(jsonSchema, nextProperties, nextRequired));
  };

  const handlers: RowHandlers = {
    onRename: (oldName, newName) => {
      const next: Record<string, unknown> = {};
      for (const key of names) next[key === oldName ? newName : key] = properties[key];
      commit(next, required.map((entry) => (entry === oldName ? newName : entry)));
    },
    onType: (name, type) => {
      const prop = properties[name];
      const nextProp: Record<string, unknown> = { type };
      const description = descriptionOf(prop);
      if (description !== '') nextProp.description = description;
      commit({ ...properties, [name]: nextProp }, required);
    },
    onRequired: (name, on) => {
      const next = on ? [...required, name] : required.filter((entry) => entry !== name);
      commit(properties, next);
    },
    onDescription: (name, text) => {
      const prop = properties[name];
      if (!isRecord(prop)) return;
      const nextProp = { ...prop };
      if (text === '') delete nextProp.description;
      else nextProp.description = text;
      commit({ ...properties, [name]: nextProp }, required);
    },
    onRemove: (name) => {
      const next = { ...properties };
      delete next[name];
      commit(next, required.filter((entry) => entry !== name));
    },
  };

  const add = () => {
    const name = nextFieldName(properties);
    commit({ ...properties, [name]: { type: 'string' } }, [...required, name]);
  };

  return (
    <div className="output-fields">
      {names.length === 0 && <p className="hint">No fields yet.</p>}
      {names.map((name) => {
        const prop = properties[name];
        const type = editableType(prop);
        return type === undefined ? (
          <ReadOnlyRow key={name} name={name} prop={prop} />
        ) : (
          <EditableRow
            key={name}
            name={name}
            prop={prop}
            type={type}
            required={required.includes(name)}
            properties={properties}
            handlers={handlers}
          />
        );
      })}
      <button type="button" className="btn btn-secondary btn-sm output-fields-add" onClick={add}>
        <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        Add field
      </button>
    </div>
  );
}
