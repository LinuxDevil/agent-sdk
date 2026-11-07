/**
 * The `output` kind's Inspector body: the top-level field table
 * (`OutputFieldTable` over `item.jsonSchema.properties`/`.required`), the
 * full schema as JSON (`JsonField`, checked to be an object schema), and
 * the `OutputSpecV2` options — `promptSchema` (the schema also goes into
 * the system prompt) and `responseFormat` (which model calls carry it).
 * Everything patches `data.item`, whose keys sit flat on the spec section.
 */
import { Field } from '../../../ui/Field';
import { Switch } from '../../../ui/controls';
import { outputSchemaCheck } from '../../../graph/v2/kinds/output';
import type { OutputSpecV2 } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { JsonField } from '../../fields/JsonField';
import { OutputFieldTable } from './OutputFieldTable';
import type { KindFieldsProps } from '../index';

type Patch = KindFieldsProps<'output'>['patch'];

const RESPONSE_FORMAT_OPTIONS: { value: 'final' | 'always'; label: string }[] = [
  { value: 'final', label: 'Final reply only' },
  { value: 'always', label: 'Every model call' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `promptSchema` switch: on deletes the key (the SDK default is `true`), off writes `false`. */
function PromptSchemaField({ item, patch }: { item: OutputSpecV2; patch: Patch }): JSX.Element {
  const onToggle = (on: boolean) => patch({ promptSchema: on ? undefined : false });
  return (
    <Field
      id="node-output-prompt-schema"
      label="Schema in system prompt"
      inline
      hint="The model also sees the JSON Schema in its instructions."
    >
      <Switch checked={item.promptSchema !== false} onChange={onToggle} />
    </Field>
  );
}

/** The `responseFormat` choice: unset means the SDK default ('final', or 'always' with promptSchema off). */
function ResponseFormatField({ item, patch }: { item: OutputSpecV2; patch: Patch }): JSX.Element {
  return (
    <ChoiceField
      id="node-output-response-format"
      label="Send schema as"
      value={item.responseFormat}
      options={RESPONSE_FORMAT_OPTIONS}
      allowUnset
      unsetLabel="Default"
      onChange={(responseFormat) => patch({ responseFormat })}
      help="'Final reply only' avoids tool-loop bugs on calls that offer tools."
    />
  );
}

/** The output Inspector described above. */
export function OutputFields({ node, patch }: KindFieldsProps<'output'>): JSX.Element {
  const { item } = node.data;
  const schema = isRecord(item.jsonSchema) ? item.jsonSchema : {};
  return (
    <>
      <Field
        id="node-output-fields"
        label="Fields"
        hint="Top-level fields. Use the JSON below for nested shapes."
      >
        <OutputFieldTable
          jsonSchema={schema}
          onChange={(jsonSchema: Record<string, unknown>) => patch({ jsonSchema })}
        />
      </Field>
      <JsonField
        id="node-output-schema"
        label="Schema (JSON)"
        rows={12}
        value={item.jsonSchema}
        onChange={(jsonSchema) => patch({ jsonSchema })}
        check={outputSchemaCheck}
      />
      <PromptSchemaField item={item} patch={patch} />
      <ResponseFormatField item={item} patch={patch} />
    </>
  );
}
