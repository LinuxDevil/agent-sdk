/**
 * The `agent` chain trigger's Inspector sub-form: the workspace agent
 * whose finished run starts this one (a select of the app's agents minus
 * the open one — a chain may not follow the agent that carries it), the
 * run status that fires (`done`, `error` or `any`) and the prompt template
 * rendered over `{ run: { status, resultText, traceId } }`.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Select, Textarea } from '../../../ui/controls';
import type { AgentListItem } from '../../../../shared/wireTypes';
import type { TriggerSpec } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import type { TriggerSubFormProps } from './CronForm';

const AFTER_ERROR = 'Pick the agent to follow';
const TEMPLATE_ERROR = 'Enter a prompt template';

type AgentItem = Extract<TriggerSpec, { type: 'agent' }>;

const ON_OPTIONS: { value: AgentItem['on']; label: string }[] = [
  { value: 'done', label: 'Finishes' },
  { value: 'error', label: 'Fails' },
  { value: 'any', label: 'Ends either way' },
];

/** Props: the variant's `item` and `patch`, plus the workspace agent list and the open agent's id. */
interface AgentChainFormProps extends TriggerSubFormProps<AgentItem> {
  agents: AgentListItem[];
  agentId: string | undefined;
}

/** The `agent` (chain) sub-form described above. */
export function AgentChainForm({ item, patch, agents, agentId }: AgentChainFormProps): JSX.Element {
  const options = agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) => ({ value: agent.id, label: agent.name || agent.id }));
  // A saved `after` the workspace no longer lists stays selectable under its own id.
  if (item.after !== '' && !options.some((option) => option.value === item.after)) {
    options.push({ value: item.after, label: item.after });
  }
  return (
    <>
      <Field
        id="node-trigger-after"
        label="After agent"
        required
        error={item.after === '' ? AFTER_ERROR : undefined}
      >
        <Select
          placeholder="Pick an agent"
          options={options}
          value={item.after}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => patch({ after: event.target.value })}
        />
      </Field>
      <ChoiceField
        id="node-trigger-on"
        label="When it"
        value={item.on}
        options={ON_OPTIONS}
        onChange={(on) => {
          if (on !== undefined) patch({ on });
        }}
      />
      <Field
        id="node-trigger-prompt-template"
        label="Prompt template"
        required
        error={item.promptTemplate.trim() === '' ? TEMPLATE_ERROR : undefined}
        hint="Variables: {{run.status}}, {{run.resultText}}, {{run.traceId}}."
      >
        <Textarea
          rows={3}
          value={item.promptTemplate}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            patch({ promptTemplate: event.target.value })
          }
        />
      </Field>
    </>
  );
}
