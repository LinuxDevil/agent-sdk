/**
 * `AgentStepForm` — the `agent` step's Inspector body (S21 fields): the
 * agent picker (the root agent's subagent keys first, then workspace
 * agents, plus "Other…" free text), the input template and the output
 * variable.
 */
import { useState, type ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Select, Textarea, type SelectGroup } from '../../../ui/controls';
import { ROOT_AGENT_ID } from '../../../graph/v2/types';
import { subagentEntryKey } from '../../../graph/v2/order';
import { useAppState } from '../../../state/AppState';
import type { KindFieldsProps } from '../index';
import { OutputVariableField } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The select value meaning "type an agent key by hand". */
const OTHER = '__other__';

/** The agent groups the picker offers: root subagent keys, then workspace agent ids. */
function agentGroups(graph: FlowProps['graph'], workspaceIds: string[]): SelectGroup[] {
  const subKeys = graph.nodes
    .filter((n) => n.owner === ROOT_AGENT_ID && n.proposed !== 'remove')
    .map((n) => subagentEntryKey(n))
    .filter((key): key is string => key !== undefined)
    .sort();
  const groups: SelectGroup[] = [];
  if (subKeys.length > 0) groups.push({ label: 'Subagents', options: subKeys.map((key) => ({ value: key, label: key })) });
  if (workspaceIds.length > 0) {
    groups.push({ label: 'Workspace agents', options: workspaceIds.map((id) => ({ value: id, label: id })) });
  }
  return groups;
}

/** The agent `Select` + "Other…" input. */
function AgentField({ id, step, graph, patch }: { id: string; step: FlowProps['node']['data']['step']; graph: FlowProps['graph']; patch(p: Record<string, unknown>): void }): JSX.Element {
  const { agents } = useAppState();
  const groups = agentGroups(graph, agents.map((a) => a.id));
  const known = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
  const value = typeof step.agent === 'string' ? step.agent : '';
  const [other, setOther] = useState(value !== '' && !known.has(value));

  const onSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (next === OTHER) {
      setOther(true);
      patch({ agent: undefined });
      return;
    }
    setOther(false);
    patch({ agent: next });
  };

  const onText = (e: ChangeEvent<HTMLInputElement>) => {
    patch({ agent: e.target.value === '' ? undefined : e.target.value });
  };

  return (
    <Field id={id} label="Agent" required={value === ''} error={value === '' ? 'Required' : undefined} hint="A subagent key or a workspace agent id.">
      {other || (value !== '' && !known.has(value)) ? (
        <Input className="mono" value={value} placeholder="agent key" onChange={onText} />
      ) : (
        <Select
          value={value}
          placeholder="Pick an agent"
          options={[{ value: OTHER, label: 'Other…' }]}
          groups={groups}
          onChange={onSelect}
        />
      )}
    </Field>
  );
}

/** The `agent` step's fields. */
export function AgentStepForm({ node, graph, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  const input = typeof step.input === 'string' ? step.input : '';
  return (
    <>
      <AgentField id={`${base}-agent`} step={step} graph={graph} patch={patch} />
      <Field id={`${base}-input`} label="Input" hint="Use {{variable}}.">
        <Textarea
          className="mono"
          rows={4}
          value={input}
          placeholder="{{input}}"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patch({ input: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <OutputVariableField id={`${base}-output`} step={step} patch={patch} />
    </>
  );
}
