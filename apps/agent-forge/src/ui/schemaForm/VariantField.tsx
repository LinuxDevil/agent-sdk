import { useMemo } from 'react';

import { Select } from '../controls';

import { schemaType } from './fieldKind';
// fallow-ignore-next-line circular-dependency -- container fields recurse into SchemaNode, which dispatches back through FIELD_RENDERERS; the recursion is inherent to schema dispatch and safe at render time.
import { fieldId, fieldLabel, ObjectChildren, SchemaNode, type FieldRendererProps } from './fields';
import { pathKey } from './schemaPath';
import type { JsonSchema } from './types';
import { defaultForSchema, matchVariant, variantOptions } from './variants';

/**
 * The `oneOf`/`anyOf` renderer: a kind picker (`Select`) plus the chosen
 * option's fields rendered as an object at the same path. Switching kind
 * resets the value to `defaultForSchema(option)` but carries over keys the
 * new option also allows (e.g. `id`, `approval` on every ToolRef).
 */
export function VariantField({ root, schema, path, value, ctx }: FieldRendererProps): JSX.Element {
  const label = fieldLabel(schema, path, ctx);
  const options = useMemo(() => variantOptions(root, schema), [root, schema]);
  const current = matchVariant(root, options, value);
  const chosen = current >= 0 ? options.find((o) => o.index === current) : undefined;
  const error = ctx.errors[pathKey(path)];

  /** Fresh default for `option`, plus old-value keys the new option also declares (except `const`s). */
  const mergeShared = (option: JsonSchema): unknown => {
    const fresh = defaultForSchema(root, option);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fresh;
    if (fresh === null || typeof fresh !== 'object' || Array.isArray(fresh)) return fresh;
    const merged = { ...(fresh as Record<string, unknown>) };
    for (const [key, v] of Object.entries(value)) {
      const prop = option.properties?.[key];
      if (prop == null || prop.const !== undefined) continue;
      merged[key] = v;
    }
    return merged;
  };

  const onKind = (next: string) => {
    const option = options.find((o) => String(o.index) === next);
    if (option == null) {
      ctx.onChange(path, undefined);
      return;
    }
    ctx.onChange(path, mergeShared(option.schema));
  };

  return (
    <div className="schema-variant" data-path={pathKey(path)}>
      <div className="field">
        <label className="field-label" htmlFor={fieldId(ctx.idPrefix, path)}>
          {label}
        </label>
        <Select
          id={fieldId(ctx.idPrefix, path)}
          aria-label={`${label} kind`}
          value={current >= 0 ? String(current) : ''}
          placeholder="Choose a kind…"
          options={options.map((o) => ({ value: String(o.index), label: o.label }))}
          disabled={ctx.readOnly}
          onChange={(e) => onKind(e.target.value)}
        />
        {error != null ? <p className="hint field-error">{error}</p> : null}
      </div>
      {chosen != null ? (
        <div className="schema-variant-body">
          <VariantBody
            root={root}
            schema={chosen.schema}
            path={path}
            value={value}
            required={false}
            ctx={ctx}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The chosen option's fields: an object's properties at `[...path, key]`, a leaf option at `path` itself. */
function VariantBody(props: FieldRendererProps): JSX.Element {
  const { root, schema, path, value, ctx } = props;
  const isObject = schemaType(schema.type) === 'object' || schema.properties != null;
  if (!isObject) {
    return <SchemaNode root={root} schema={schema} path={path} value={value} required={false} ctx={ctx} />;
  }
  return <ObjectChildren {...props} />;
}
