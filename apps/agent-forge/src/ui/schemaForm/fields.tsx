import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { Field } from '../Field';
import { Input, Select, Switch, Textarea } from '../controls';

import { fieldKind, humanize, schemaType, type FieldKind } from './fieldKind';
import { getAtPath, pathKey, resolveRef } from './schemaPath';
import type { JsonSchema, SchemaPath } from './types';

/** Everything one field renderer needs: position in the tree plus the form-wide context. */
export interface FieldRendererProps {
  /** Root schema; holds `definitions`/`$defs` for `$ref` resolution. */
  root: JsonSchema;
  /** This node's schema, already `$ref`-resolved by {@link SchemaNode}. */
  schema: JsonSchema;
  path: SchemaPath;
  /** The value at `path`. */
  value: unknown;
  /** Whether the parent object's `required` lists this key. */
  // fallow-ignore-next-line unused-component-prop -- read by PrimitiveArrayField/SchemaNode; leaf renderers share the props type without reading it.
  required: boolean;
  ctx: {
    idPrefix: string;
    errors: Record<string, string>;
    readOnly: boolean;
    labels: Record<string, string>;
    hints: Record<string, string>;
    onChange(path: SchemaPath, next: unknown): void;
  };
}

/** Field value convention: every control maps its empty state to `undefined` (removes the key). */
const emptyToUndefined = (text: string): string | undefined => (text === '' ? undefined : text);

/** Label resolution order: `labels[path]` → schema `title` → `humanize(key)`. */
function fieldLabel(schema: JsonSchema, path: SchemaPath, ctx: FieldRendererProps['ctx']): string {
  const key = pathKey(path);
  const last = path[path.length - 1];
  return ctx.labels[key] ?? schema.title ?? humanize(last == null ? key : String(last));
}

/** Hint resolution order: `hints[path]` → schema `description`. */
function fieldHint(schema: JsonSchema, path: SchemaPath, ctx: FieldRendererProps['ctx']): string | undefined {
  return ctx.hints[pathKey(path)] ?? schema.description;
}

/** DOM id for a path: `${idPrefix}-${pathKey}` with non-id characters dashed. */
function fieldId(idPrefix: string, path: SchemaPath): string {
  return `${idPrefix}-${pathKey(path).replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** `'Default: 12'`, else the first example; the input's grey text tells you what skipping gives you. */
function placeholder(schema: JsonSchema): string | undefined {
  if (schema.default != null) return `Default: ${String(schema.default)}`;
  const example = schema.examples?.[0];
  return example == null ? undefined : String(example);
}

function StringField({ schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  return (
    <Input
      type={schema.format === 'uri' ? 'url' : 'text'}
      value={value == null ? '' : String(value)}
      placeholder={placeholder(schema)}
      disabled={ctx.readOnly}
      onChange={(e) => ctx.onChange(path, emptyToUndefined(e.target.value))}
    />
  );
}

function TextField({ schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  return (
    <Textarea
      prose
      autoGrow
      value={value == null ? '' : String(value)}
      placeholder={placeholder(schema)}
      disabled={ctx.readOnly}
      onChange={(e) => ctx.onChange(path, emptyToUndefined(e.target.value))}
    />
  );
}

function SecretField({ path, value, ctx }: FieldRendererProps): JSX.Element {
  return (
    <Input
      type="password"
      autoComplete="off"
      value={value == null ? '' : String(value)}
      placeholder="Not set"
      disabled={ctx.readOnly}
      onChange={(e) => ctx.onChange(path, emptyToUndefined(e.target.value))}
    />
  );
}

/** An enum value usable as an identifier gets a humanized label; anything else shows as-is. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function enumLabel(v: unknown): string {
  const s = String(v);
  return IDENTIFIER.test(s) ? humanize(s) : s;
}

function EnumField({ schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  const options = (schema.enum ?? []).map((v) => ({ value: String(v), label: enumLabel(v) }));
  return (
    <Select
      value={value == null ? '' : String(value)}
      placeholder="Choose…"
      options={options}
      disabled={ctx.readOnly}
      onChange={(e) =>
        ctx.onChange(
          path,
          e.target.value === '' ? undefined : (schema.enum ?? []).find((v) => String(v) === e.target.value),
        )
      }
    />
  );
}

/**
 * Number/integer input. Keeps the raw text in local state so typing `1.` or
 * `-` doesn't snap back; unparseable text stays put and reports
 * `Must be a number.` until it clears or parses.
 */
function NumberField({ schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  const integer = schemaType(schema.type) === 'integer';
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const change = (text: string) => {
    setDraft(text);
    if (text === '') {
      setInvalid(false);
      ctx.onChange(path, undefined);
      return;
    }
    const n = Number(text);
    if (Number.isNaN(n)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    ctx.onChange(path, n);
  };
  return (
    <>
      <Input
        type="number"
        inputMode="decimal"
        step={integer ? 1 : 'any'}
        min={schema.minimum ?? schema.exclusiveMinimum}
        max={schema.maximum ?? schema.exclusiveMaximum}
        value={draft ?? (value == null ? '' : String(value))}
        placeholder={placeholder(schema)}
        disabled={ctx.readOnly}
        invalid={invalid}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          setDraft(undefined);
          setInvalid(false);
        }}
      />
      {invalid ? <p className="hint field-error">Must be a number.</p> : null}
    </>
  );
}

function BooleanField({ schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  return (
    <Switch
      stateLabel
      checked={value === undefined ? schema.default === true : value === true}
      disabled={ctx.readOnly}
      onChange={(checked) => ctx.onChange(path, checked)}
    />
  );
}

function ObjectField(props: FieldRendererProps): JSX.Element {
  const { root, schema, path, value, ctx } = props;
  const key = pathKey(path);
  const hint = fieldHint(schema, path, ctx);
  const required = new Set(schema.required ?? []);
  return (
    <fieldset className="schema-object" data-path={key}>
      <legend className="schema-legend">{fieldLabel(schema, path, ctx)}</legend>
      {hint != null ? <p className="schema-object-hint">{hint}</p> : null}
      {Object.entries(schema.properties ?? {}).map(([childKey, child]) => (
        <SchemaNode
          key={childKey}
          root={root}
          schema={child}
          path={[...path, childKey]}
          value={getAtPath(value, [childKey])}
          required={required.has(childKey)}
          ctx={ctx}
        />
      ))}
    </fieldset>
  );
}

function PrimitiveArrayField(props: FieldRendererProps): JSX.Element {
  const { root, schema, path, value, required, ctx } = props;
  const label = fieldLabel(schema, path, ctx);
  const list = Array.isArray(value) ? value : [];
  const items = schema.items == null ? undefined : resolveRef(root, schema.items);
  const itemType = items == null ? undefined : schemaType(items.type);
  const numeric = itemType === 'number' || itemType === 'integer';
  const setList = (next: unknown[]) => ctx.onChange(path, next.length === 0 && !required ? undefined : next);
  const setItem = (index: number, text: string) => {
    const next = [...list];
    next[index] = numeric && text !== '' ? Number(text) : text;
    setList(next);
  };
  return (
    <div className="schema-list">
      {list.map((item, i) => (
        <div className="schema-list-row" key={i}>
          <Input
            id={`${fieldId(ctx.idPrefix, path)}-${i + 1}`}
            type={numeric ? 'number' : 'text'}
            inputMode={numeric ? 'decimal' : undefined}
            aria-label={`${label} ${i + 1}`}
            value={item == null ? '' : String(item)}
            disabled={ctx.readOnly}
            onChange={(e) => setItem(i, e.target.value)}
          />
          {ctx.readOnly ? null : (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Remove ${label} ${i + 1}`}
              onClick={() => setList(list.filter((_, j) => j !== i))}
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      {ctx.readOnly ? null : (
        <button type="button" className="btn btn-sm schema-list-add" onClick={() => setList([...list, ''])}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add
        </button>
      )}
    </div>
  );
}

/**
 * The fallback: the value as pretty-printed JSON in a mono textarea. Parses on
 * blur; invalid text stays put and reports `Not valid JSON: …` without
 * touching the form value.
 */
function JsonField({ path, value, ctx }: FieldRendererProps): JSX.Element {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [parseError, setParseError] = useState<string | undefined>(undefined);
  const commit = () => {
    if (draft == null) return;
    const text = draft.trim();
    if (text === '') {
      setDraft(undefined);
      ctx.onChange(path, undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      setDraft(undefined);
      setParseError(undefined);
      ctx.onChange(path, parsed);
    } catch (e) {
      setParseError(`Not valid JSON: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <Textarea
        value={draft ?? (value === undefined ? '' : JSON.stringify(value, null, 2))}
        placeholder="{}"
        disabled={ctx.readOnly}
        invalid={parseError != null}
        onChange={(e) => {
          setDraft(e.target.value);
          setParseError(undefined);
        }}
        onBlur={commit}
      />
      {parseError != null ? <p className="hint field-error">{parseError}</p> : null}
    </>
  );
}

/** Registry the renderers dispatch through; U14 adds `variant`, `objectArray` and `record` entries. */
// fallow-ignore-next-line unused-export -- public dispatch table, re-exported from SchemaForm.tsx; U14 registers more kinds.
export const FIELD_RENDERERS: Record<FieldKind, (p: FieldRendererProps) => JSX.Element> = {
  string: StringField,
  text: TextField,
  secret: SecretField,
  enum: EnumField,
  number: NumberField,
  integer: NumberField,
  boolean: BooleanField,
  object: ObjectField,
  primitiveArray: PrimitiveArrayField,
  json: JsonField,
};

/** Resolves the node's `$ref`, and an `items.$ref` against the real root so `fieldKind` sees the item type. */
function resolveNode(root: JsonSchema, schema: JsonSchema): JsonSchema {
  const resolved = resolveRef(root, schema);
  return resolved.items?.$ref != null ? { ...resolved, items: resolveRef(root, resolved.items) } : resolved;
}

/**
 * One schema node: resolves refs, picks the kind and dispatches through
 * {@link FIELD_RENDERERS}. Objects get the fieldset chrome; every leaf sits in
 * a U06 {@link Field} (inline for boolean).
 */
export function SchemaNode(props: FieldRendererProps): JSX.Element {
  const resolved = resolveNode(props.root, props.schema);
  const kind = fieldKind(resolved);
  const p: FieldRendererProps = { ...props, schema: resolved };
  const Renderer = FIELD_RENDERERS[kind];
  if (kind === 'object') return <Renderer {...p} />;
  const key = pathKey(props.path);
  return (
    <Field
      label={fieldLabel(resolved, props.path, props.ctx)}
      hint={fieldHint(resolved, props.path, props.ctx)}
      error={props.ctx.errors[key]}
      required={props.required}
      id={fieldId(props.ctx.idPrefix, props.path)}
      inline={kind === 'boolean'}
      dataPath={key}
    >
      <Renderer {...p} />
    </Field>
  );
}
