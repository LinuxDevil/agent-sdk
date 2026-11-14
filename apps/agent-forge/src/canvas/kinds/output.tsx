/**
 * The `KindView` for `output` nodes — the agent's `spec.output`
 * (`OutputSpecV2`): the JSON Schema the final reply is validated into
 * `result.object` with. The card's title is 'Output', its chip the schema
 * delivery ('format only' with `promptSchema: false`, 'every call' with
 * `responseFormat: 'always'`), and its rows the first four top-level
 * `properties` (`name type`, `?` when not required) with the rest
 * collapsed into '… <n> more'. `Fields` is the output Inspector
 * (`output/OutputFields.tsx`); the palette offers a single "Output schema"
 * entry under Output that is unavailable once the owner already has one.
 */
import { Braces } from 'lucide-react';
import { outputUnavailableReason } from '../../graph/v2/kinds/output';
import type { NodeOfKind } from '../../graph/v2/types';
import { OutputFields } from './output/OutputFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `schema.properties` when it is a plain object, else `{}`. */
function propertiesOf(jsonSchema: unknown): Record<string, unknown> {
  return isRecord(jsonSchema) && isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
}

/** The string entries of `schema.required`. */
function requiredOf(jsonSchema: unknown): Set<string> {
  const required = isRecord(jsonSchema) && Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  return new Set(required.filter((name): name is string => typeof name === 'string'));
}

/** The row's type text: the property's `type`, or 'any' when it is not a plain string. */
function typeText(prop: unknown): string {
  return isRecord(prop) && typeof prop.type === 'string' ? prop.type : 'any';
}

/** Up to four property rows, then a '… <n> more' summary row. */
function rows(node: NodeOfKind<'output'>): NodeRow[] {
  const { jsonSchema } = node.data.item;
  const properties = propertiesOf(jsonSchema);
  const required = requiredOf(jsonSchema);
  const names = Object.keys(properties);
  const shown = names.slice(0, 4).map((name) => ({
    k: name,
    v: `${typeText(properties[name])}${required.has(name) ? '' : '?'}`,
  }));
  if (names.length > 4) shown.push({ k: '…', v: `${names.length - 4} more` });
  return shown;
}

/** The card chip: how the schema reaches the model, when it is not the default. */
function chip(node: NodeOfKind<'output'>): string | undefined {
  const { promptSchema, responseFormat } = node.data.item;
  if (promptSchema === false) return 'format only';
  if (responseFormat === 'always') return 'every call';
  return undefined;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'output',
    group: 'Output',
    label: 'Output schema',
    description: 'Returns structured JSON',
    kind: 'output',
    create: () => ({
      kind: 'output',
      data: {
        item: {
          jsonSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    }),
    unavailable: outputUnavailableReason,
  },
];

/** The `output` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const OUTPUT_VIEW: KindView<'output'> = {
  label: 'Output schema',
  tone: 'success',
  Icon: Braces,
  title: () => 'Output',
  chip,
  rows,
  ports: { in: true, out: false },
  Fields: OutputFields,
  palette: PALETTE,
};
