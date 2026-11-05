/**
 * The `agent` kind's Inspector body (C03), four `InspectorSection`s in the
 * ticket's order: Identity (name, the inline `subagentKey`, description),
 * Model (picker, fallbacks, sampling settings, reasoning), Instructions
 * (source toggle, prompt ref, per-family tails) and Advanced (the
 * remaining `AGENT_FIELD_KEYS` as one JSON object). Field-level edits go
 * through `patch` (which merges into `data.fields`); `subagentKey` lives
 * outside `fields` so it goes through `replace`.
 */
import type { ChangeEvent } from 'react';
import { InspectorSection } from '../../../components/InspectorSection';
import { Field } from '../../../ui/Field';
import { Input, Textarea } from '../../../ui/controls';
import { sectionChildren } from '../../../graph/v2/order';
import { AGENT_MODEL_PATTERN, AGENT_NAME_PATTERN } from '../../../graph/v2/kinds/agent';
import type { AgentFields, AgentNodeData, GraphNode, NodeOfKind } from '../../../graph/v2/types';
import { AGENT_FIELD_KEYS } from '../../../graph/v2/types';
import { JsonField } from '../../fields/JsonField';
import { StringListField } from '../../fields/StringListField';
import { InstructionsField } from './InstructionsField';
import { ModelPicker, MODEL_ID_ERROR } from './ModelPicker';
import { ModelSettingsFields } from './ModelSettingsFields';
import { ReasoningField } from './ReasoningField';
import type { KindFieldsProps } from '../index';

const SUBAGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME_PATTERN_ERROR = 'Use letters, digits, space, dot, dash or underscore, up to 64 characters';
const SUBAGENT_KEY_PATTERN_ERROR = 'Use lower-case letters, digits, dash or underscore';

/** `AGENT_FIELD_KEYS` the form edits directly — everything else is one "Other settings" JSON object. */
const FORM_KEYS = new Set<string>([
  'name',
  'description',
  'model',
  'fallbackModels',
  'instructions',
  'instructionsByFamily',
  'promptRef',
  'modelSettings',
  'reasoning',
]);

/** The `AGENT_FIELD_KEYS` left for the Advanced JSON, in spec order. */
const ADVANCED_KEYS = AGENT_FIELD_KEYS.filter((key) => !FORM_KEYS.has(key));
const ADVANCED_SET = new Set<string>(ADVANCED_KEYS);

/** The `subagents` record key a sibling node stands for (inline agent or ref/remote), or `undefined`. */
function siblingKey(node: GraphNode): string | undefined {
  if (node.kind === 'subagent') return node.data.key;
  if (node.kind === 'agent') return (node.data as AgentNodeData).subagentKey;
  return undefined;
}

/** The props IdentityFields needs of `KindFieldsProps<'agent'>`. */
type IdentityProps = Pick<KindFieldsProps<'agent'>, 'node' | 'graph' | 'patch' | 'replace'>;

/** The inline error for `data.subagentKey`, or `undefined`. */
function subagentKeyError(node: NodeOfKind<'agent'>, graph: IdentityProps['graph']): string | undefined {
  const key = node.data.subagentKey ?? '';
  if (key === '') return 'Required';
  if (!SUBAGENT_KEY_PATTERN.test(key)) return SUBAGENT_KEY_PATTERN_ERROR;
  const taken = sectionChildren(graph, node.owner ?? '', 'subagents')
    .filter((n) => n.id !== node.id)
    .some((n) => siblingKey(n) === key);
  return taken ? 'Another subagent already uses this name' : undefined;
}

/** The Identity section: name, the inline-only subagent key and the description. */
function IdentityFields({ node, graph, patch, replace }: IdentityProps): JSX.Element {
  const { fields } = node.data;
  const inline = node.data.subagentKey !== undefined;
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  return (
    <>
      <Field
        id="node-agent-name"
        label="Name"
        required
        error={name === '' ? 'Required' : AGENT_NAME_PATTERN.test(name) ? undefined : NAME_PATTERN_ERROR}
        hint="Shown in traces and the agents list."
      >
        <Input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value })} />
      </Field>
      {inline ? (
        <Field
          id="node-agent-key"
          label="Subagent name"
          required
          error={subagentKeyError(node, graph)}
          hint="The main agent calls it by this name."
        >
          <Input
            value={node.data.subagentKey ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => replace({ ...node.data, subagentKey: e.target.value })}
          />
        </Field>
      ) : null}
      <Field
        id="node-agent-description"
        label="Description"
        required={inline}
        error={
          inline && description.trim() === ''
            ? 'A subagent needs a description so the main agent knows when to use it'
            : undefined
        }
        hint={inline ? undefined : 'Used when another agent hands off to this one.'}
      >
        <Textarea
          value={description}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patch({ description: e.target.value })}
          rows={2}
          prose
        />
      </Field>
    </>
  );
}

/** The Advanced section's `check`: only the un-handled `AGENT_FIELD_KEYS` may appear. */
function checkAdvanced(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Enter a JSON object';
  for (const key of Object.keys(value)) {
    if (!ADVANCED_SET.has(key)) return `Unknown setting '${key}'`;
  }
  return undefined;
}

/** The fields the Advanced JSON edits: the `AGENT_FIELD_KEYS` entries present in `fields`. */
function advancedOf(fields: AgentFields): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of ADVANCED_KEYS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The agent Inspector body: the four sections described above. */
export function AgentFields({ node, graph, patch, replace }: KindFieldsProps<'agent'>): JSX.Element {
  const { fields } = node.data;
  const onAdvanced = (value: unknown) => {
    const next = (value ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const key of ADVANCED_KEYS) update[key] = next[key];
    patch(update);
  };
  return (
    <>
      <InspectorSection id="agent-identity" title="Identity">
        <IdentityFields node={node} graph={graph} patch={patch} replace={replace} />
      </InspectorSection>
      <InspectorSection id="agent-model" title="Model">
        <ModelPicker id="node-agent-model" value={fields.model} onChange={(model) => patch({ model })} />
        <StringListField
          id="node-agent-fallbacks"
          label="Fallback models"
          value={fields.fallbackModels}
          onChange={(fallbackModels) => patch({ fallbackModels })}
          placeholder="Add a model id"
          validateItem={(item) => (AGENT_MODEL_PATTERN.test(item) ? undefined : MODEL_ID_ERROR)}
          help="Tried in order when the main model fails."
        />
        <ModelSettingsFields settings={fields.modelSettings} patch={patch} />
        <ReasoningField model={fields.model} reasoning={fields.reasoning} patch={patch} />
      </InspectorSection>
      <InspectorSection id="agent-instructions" title="Instructions">
        <InstructionsField node={node} patch={patch} />
      </InspectorSection>
      <InspectorSection id="agent-advanced" title="Advanced">
        <JsonField
          id="node-agent-advanced"
          label="Other settings (JSON)"
          value={advancedOf(fields)}
          onChange={onAdvanced}
          rows={8}
          check={checkAdvanced}
          help="Limits, retries and other run settings. A form arrives in a later update."
        />
      </InspectorSection>
    </>
  );
}
