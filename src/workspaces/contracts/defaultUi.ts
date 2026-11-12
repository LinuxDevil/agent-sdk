import type { WorkType } from './page';
import type { PageUi, UiBindingTarget, UiComponent } from './ui';

type JsonSchema = Record<string, unknown>;

const FIELD_NAME = /^[A-Za-z_][\w-]*$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const SCALARS = new Set(['number', 'integer', 'boolean']);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parts(schema: JsonSchema): JsonSchema[] {
  const allOf = Array.isArray(schema.allOf) ? schema.allOf.filter(isRecord) : [];
  return [schema, ...allOf.flatMap(parts)];
}

function typesOf(schema: JsonSchema): string[] {
  return parts(schema).flatMap((part) => (typeof part.type === 'string' ? [part.type] : Array.isArray(part.type) ? part.type.filter((type): type is string => typeof type === 'string') : []));
}

function isBindable(name: string, field: unknown): field is JsonSchema {
  return isRecord(field) && FIELD_NAME.test(name) && !RESERVED.has(name);
}

function outputFields(schema: JsonSchema): [string, JsonSchema][] {
  const fields = new Map<string, JsonSchema>();
  for (const part of parts(schema)) {
    const properties = isRecord(part.properties) ? part.properties : {};
    for (const [name, field] of Object.entries(properties)) if (!fields.has(name) && isBindable(name, field)) fields.set(name, field);
  }
  return [...fields];
}

function outputComponent(name: string, field: JsonSchema): UiComponent {
  const types = typesOf(field);
  const source = `outputs.${name}`;
  if (types.length === 1 && types[0] === 'string') return { type: 'markdown', source, label: name };
  if (types.length > 0 && types.every((type) => type === 'array')) return { type: 'table', source, label: name };
  if (types.length > 0 && types.every((type) => SCALARS.has(type))) return { type: 'text', source, label: name };
  return { type: 'json', source, label: name };
}

function hasRef(schema: JsonSchema): boolean {
  return parts(schema).some((part) => typeof part.$ref === 'string');
}

function outputComponents(schema: Record<string, unknown> | string | undefined): UiComponent[] {
  if (schema === undefined) return [];
  const fields = typeof schema === 'string' || hasRef(schema) ? [] : outputFields(schema);
  if (fields.length === 0) return [{ type: 'json', source: 'outputs', label: 'Output' }];
  return fields.map(([name, field]) => outputComponent(name, field));
}

/** Builds the page UI a page gets when it has no `ui/page.ui.json`: a schema form over the inputs, run controls, status, progress, one view per output field and an artifact gallery; the same for every execution type, and always valid against `effective`. */
export function defaultPageUi(effective: UiBindingTarget, _workType: WorkType): PageUi {
  const inputs: UiComponent[] = effective.inputs?.schema === undefined ? [] : [{ type: 'schemaForm', bind: 'inputs', label: 'Inputs' }];
  const gallery: UiComponent[] = (effective.outputs?.artifacts ?? []).length > 0 ? [{ type: 'artifactGallery', label: 'Artifacts' }] : [];
  const children: UiComponent[] = [
    ...inputs,
    { type: 'row', children: [{ type: 'runButton' }, { type: 'cancelButton' }] },
    { type: 'runStatus' },
    { type: 'progress' },
    ...outputComponents(effective.outputs?.schema),
    ...gallery,
  ];
  return { schema: 'lousho.ui/1', layout: { type: 'stack', children } };
}
