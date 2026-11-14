/**
 * The `handoff` kind's Inspector body: the "Hand off to" picker (sibling
 * subagent keys, then workspace agent ids, then a free "Other…" input for
 * a target the list cannot name), the transfer tool's name and
 * description, the input filter preset and the optional input JSON
 * schema. Everything patches `data.item` — the fields sit flat on the
 * `HandoffSpec`, so no `replace` is needed.
 */
import type { ChangeEvent } from 'react';
import { useAppState } from '../../../state/AppState';
import { Field } from '../../../ui/Field';
import { Input, Select, Textarea } from '../../../ui/controls';
import { HANDOFF_TOOL_NAME_PATTERN } from '../../../graph/v2/kinds/handoff';
import { subagentSiblingKeys } from '../../../graph/v2/order';
import type { HandoffSpec } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { JsonField } from '../../fields/JsonField';
import type { KindFieldsProps } from '../index';

const OTHER_TARGET = '__other';
const TOOL_NAME_ERROR = 'Use letters, digits, dash or underscore (max 64)';
const SCHEMA_ERROR = 'Use a JSON Schema with type: object';

type InputFilter = NonNullable<HandoffSpec['inputFilter']>;

const FILTER_OPTIONS: { value: InputFilter; label: string }[] = [
  { value: 'removeToolCalls', label: 'Without tool calls' },
  { value: 'lastUserMessage', label: 'Only the last user message' },
];

/** `check` for the schema JsonField: the handoff input must be a JSON Schema with `type: 'object'`. */
function objectSchemaOk(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['type'] === 'object'
    ? undefined
    : SCHEMA_ERROR;
}

/**
 * The "Hand off to" select plus the "Other…" free input. `item.agent`
 * holds a sibling subagent key or a workspace agent id verbatim; a value
 * the select does not list keeps "Other…" selected and shows the input.
 */
function TargetField({
  node,
  graph,
  patch,
}: Pick<KindFieldsProps<'handoff'>, 'node' | 'graph' | 'patch'>): JSX.Element {
  const { agents, agentId } = useAppState();
  const agent = node.data.item.agent;
  const subagentOptions = subagentSiblingKeys(graph, node.owner).map((key) => ({
    value: key,
    label: key,
  }));
  const agentOptions = agents
    .filter((candidate) => candidate.id !== agentId)
    .map((candidate) => ({ value: candidate.id, label: candidate.name || candidate.id }));
  const known =
    agent !== '' &&
    (subagentOptions.some((option) => option.value === agent) ||
      agentOptions.some((option) => option.value === agent));
  return (
    <>
      <Field
        id="node-handoff-agent"
        label="Hand off to"
        fieldPath=".agent"
        required
        error={agent === '' ? 'Pick who takes over' : undefined}
        hint="The target continues the conversation."
      >
        <Select
          groups={[
            ...(subagentOptions.length > 0 ? [{ label: 'Subagents', options: subagentOptions }] : []),
            ...(agentOptions.length > 0 ? [{ label: 'Agents', options: agentOptions }] : []),
          ]}
          options={[{ value: OTHER_TARGET, label: 'Other…' }]}
          value={known ? agent : OTHER_TARGET}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            // "Other…" clears the agent so `known` goes false and the free input appears.
            patch({ agent: event.target.value === OTHER_TARGET ? '' : event.target.value });
          }}
        />
      </Field>
      {!known && (
        <Field
          id="node-handoff-agent-other"
          label="Target name"
          fieldPath=".agent"
          hint="An agent id or a subagent name."
        >
          <Input
            value={agent}
            onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ agent: event.target.value })}
          />
        </Field>
      )}
    </>
  );
}

/** The handoff Inspector described above. */
export function HandoffFields({ node, graph, patch }: KindFieldsProps<'handoff'>): JSX.Element {
  const { item } = node.data;
  const toolName = item.toolName ?? '';
  const toolNameError =
    toolName !== '' && !HANDOFF_TOOL_NAME_PATTERN.test(toolName) ? TOOL_NAME_ERROR : undefined;
  return (
    <>
      <TargetField node={node} graph={graph} patch={patch} />
      <Field
        id="node-handoff-tool"
        label="Tool name"
        fieldPath=".toolName"
        error={toolNameError}
        hint="What the model calls to hand off."
      >
        <Input
          value={toolName}
          placeholder={`transfer_to_${item.agent}`}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ toolName: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      <Field
        id="node-handoff-description"
        label="Description"
        fieldPath=".description"
        hint="Tells the model when to hand off."
      >
        <Textarea
          rows={2}
          value={item.description ?? ''}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            patch({ description: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      <ChoiceField
        id="node-handoff-filter"
        label="What the target sees"
        fieldPath=".inputFilter"
        value={item.inputFilter}
        allowUnset
        unsetLabel="Default (full history)"
        options={FILTER_OPTIONS}
        onChange={(inputFilter) => patch({ inputFilter })}
      />
      <JsonField
        id="node-handoff-schema"
        label="Input schema"
        fieldPath=".inputJsonSchema"
        rows={6}
        value={item.inputJsonSchema}
        onChange={(inputJsonSchema) => patch({ inputJsonSchema })}
        check={objectSchemaOk}
        help="Arguments the model must pass, e.g. a reason."
      />
    </>
  );
}
