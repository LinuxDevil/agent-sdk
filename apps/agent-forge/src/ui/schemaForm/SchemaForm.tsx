import { SchemaNode, type FieldRendererProps } from './fields';
import { getAtPath, resolveRef, setAtPath } from './schemaPath';
import type { JsonSchema, SchemaPath } from './types';
import './schemaForm.css';

/** Props for {@link SchemaForm}. */
export interface SchemaFormProps {
  /** Root schema; also holds `definitions`/`$defs` for `$ref` resolution. */
  schema: JsonSchema;
  /** The whole form value (an object for object schemas). */
  value: unknown;
  /** Called with the whole new value after any single-field edit. */
  onChange(next: unknown): void;
  /** DOM id prefix, e.g. `'configure-model'` → `configure-model-modelSettings-temperature`. */
  idPrefix: string;
  /** `{ pathKey: message }` from `issuesByPath`; shown under the field at that path. */
  errors?: Record<string, string>;
  /** Disables every control and hides list add/remove buttons. */
  readOnly?: boolean;
  /** Top-level keys to skip. */
  hiddenKeys?: string[];
  /** `path → label` overrides; wins over schema `title`. */
  labels?: Record<string, string>;
  /** `path → hint` overrides; wins over schema `description`. */
  hints?: Record<string, string>;
}

/**
 * Renders an editable form for a JSON Schema (draft-07 subset): labels from
 * `labels`/`title`/`humanize(key)`, hints from `hints`/`description`, defaults
 * as placeholders and per-field dispatch through `FIELD_RENDERERS`. Shapes the
 * renderer cannot draw yet fall back to a JSON textarea. Used by the Configure
 * tab (A07) and inspector forms (C10, C12).
 */
export function SchemaForm(props: SchemaFormProps): JSX.Element {
  const {
    schema,
    value,
    onChange,
    idPrefix,
    errors = {},
    readOnly = false,
    hiddenKeys = [],
    labels = {},
    hints = {},
  } = props;
  const ctx: FieldRendererProps['ctx'] = {
    idPrefix,
    errors,
    readOnly,
    labels,
    hints,
    onChange: (path: SchemaPath, next: unknown) => onChange(setAtPath(value, path, next)),
  };
  const root = resolveRef(schema, schema);
  const properties = root.properties ?? {};
  const required = new Set(root.required ?? []);
  return (
    <div className="schema-form">
      {Object.keys(properties)
        .filter((key) => !hiddenKeys.includes(key))
        .map((key) => (
          <SchemaNode
            key={key}
            root={schema}
            schema={properties[key]}
            path={[key]}
            value={getAtPath(value, [key])}
            required={required.has(key)}
            ctx={ctx}
          />
        ))}
    </div>
  );
}

// fallow-ignore-next-line unused-export -- contract surface: the form screens and U14 dispatch custom kinds through this table.
export { FIELD_RENDERERS } from './fields';
// fallow-ignore-next-line unused-type -- contract surface: renderer entries take these props.
export type { FieldRendererProps } from './fields';
