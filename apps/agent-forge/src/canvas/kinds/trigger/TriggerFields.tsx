/**
 * The `trigger` kind's Inspector body: the Type select (the trigger
 * catalog's five types — and any extra type, which keeps a schema form —
 * each labelled with its `runsUnder` suffix) swaps the whole `item` for the
 * type's empty value while keeping `id`, the Id input writes `item.id`, and
 * one per-type sub-form edits the rest: `CronForm`, `WebhookForm`,
 * `ChannelForm`, `AgentChainForm`, or `SchemaTriggerForm` for a catalog
 * type outside the five PLAN kinds. `chat` carries no fields — just its
 * help line.
 */
import type { ChangeEvent } from 'react';
import { useAppState } from '../../../state/AppState';
import { Field } from '../../../ui/Field';
import { Input, Select, type SelectOption } from '../../../ui/controls';
import type { CatalogTriggerType } from '../../../../shared/wireTypes';
import { TRIGGER_ID_PATTERN } from '../../../graph/v2/kinds/trigger';
import type { Graph, TriggerNodeData } from '../../../graph/v2/types';
import { useCatalog } from '../../useCatalog';
import { AgentChainForm } from './AgentChainForm';
import { ChannelForm } from './ChannelForm';
import { CronForm } from './CronForm';
import { SchemaTriggerForm } from './SchemaTriggerForm';
import { FORM_TRIGGER_TYPES, emptyTriggerItem } from './triggerItem';
import { WebhookForm } from './WebhookForm';
import type { KindFieldsProps } from '../index';
import './trigger.css';

/** Capitalises `text`'s first letter — the `runsUnder` suffix reads "Dev, worker, studio". */
function capitalise(text: string): string {
  return text === '' ? text : text[0].toUpperCase() + text.slice(1);
}

/** The select label of one catalog row: its title plus the runtimes that start it. */
function optionLabel(info: CatalogTriggerType): string {
  const under = info.runsUnder.join(', ');
  return under === '' ? info.title : `${info.title} · ${capitalise(under)}`;
}

/**
 * Another live trigger already carries `item.id` — the spec schema and
 * `validateGraph`'s duplicate-id core check flag the same collision.
 */
function idTaken(node: Graph['nodes'][number], graph: Graph): boolean {
  const id = (node.data as TriggerNodeData).item.id;
  return graph.nodes.some(
    (n) =>
      n.id !== node.id &&
      n.kind === 'trigger' &&
      n.proposed !== 'remove' &&
      (n.data as TriggerNodeData).item.id === id
  );
}

/** The chat type's only content: its help line. */
function ChatHint(): JSX.Element {
  return (
    <div className="field">
      <p className="hint">Runs when someone messages the agent in Studio or over HTTP.</p>
    </div>
  );
}

/** The trigger Inspector described above. */
export function TriggerFields({ node, graph, patch, replace }: KindFieldsProps<'trigger'>): JSX.Element {
  const { item } = node.data;
  const { agents, agentId } = useAppState();
  const catalog = useCatalog('triggers');
  const types = catalog.data ?? [];
  const options: SelectOption[] = types.map((info) => ({
    value: info.type,
    label: optionLabel(info),
    title: info.description,
  }));
  if (!options.some((option) => option.value === item.type)) {
    options.push({ value: item.type, label: item.type });
  }
  const picked = types.find((info) => info.type === item.type);
  const onType = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (next !== item.type) replace({ item: emptyTriggerItem(next, item.id) });
  };
  const idError = !TRIGGER_ID_PATTERN.test(item.id)
    ? 'The id can use letters, digits, dash or underscore'
    : idTaken(node, graph)
      ? 'Another trigger uses this id'
      : undefined;
  const schemaOnly = picked !== undefined && !FORM_TRIGGER_TYPES.includes(item.type as never);
  return (
    <>
      <Field id="node-trigger-type" label="Type" hint={picked?.description ?? catalog.error}>
        <Select options={options} value={item.type} onChange={onType} />
      </Field>
      <Field id="node-trigger-id" label="Id" required error={idError}>
        <Input value={item.id} onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ id: event.target.value })} />
      </Field>
      {item.type === 'chat' && <ChatHint />}
      {item.type === 'cron' && <CronForm item={item} patch={patch} />}
      {item.type === 'webhook' && <WebhookForm item={item} patch={patch} />}
      {item.type === 'channel' && <ChannelForm item={item} patch={patch} />}
      {item.type === 'agent' && <AgentChainForm item={item} patch={patch} agents={agents} agentId={agentId} />}
      {schemaOnly && <SchemaTriggerForm info={picked} item={item} replace={replace} />}
    </>
  );
}
