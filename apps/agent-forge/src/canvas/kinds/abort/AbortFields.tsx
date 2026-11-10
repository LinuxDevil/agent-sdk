/**
 * The `abort` kind's Inspector body: the Trigger select offers the graph's
 * webhook and channel trigger nodes (labelled with the C12 title plus the
 * trigger id) and writes `item.triggerId`; it is disabled with a reason
 * while no such trigger exists. `Cancel when`/`Which run` edit the `when`
 * and `match` safeExpressions (mono inputs), `Cancel` the `scope` choice
 * (no unset — a listener always has a scope), and `Id` the entry id with
 * the spec pattern and uniqueness checks.
 */
import type { ChangeEvent } from 'react';
import {
  ABORT_ID_PATTERN,
  abortTriggerNodes,
  allAbortIds,
  NO_ABORT_TRIGGER_MESSAGE,
} from '../../../graph/v2/kinds/abort';
import type { AbortListenerSpec } from '../../../graph/v2/specTypes';
import type { Graph, NodeOfKind } from '../../../graph/v2/types';
import { Field } from '../../../ui/Field';
import { Input, Select, type SelectOption } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import { triggerTitle } from '../trigger/triggerItem';
import type { KindFieldsProps } from '../index';

/** Trim-empty is empty, matching the validator's `blank`. */
function blank(value: string): boolean {
  return value.trim() === '';
}

/** The id field's error: outside the spec pattern, or used by another listener. */
function idError(node: NodeOfKind<'abort'>, graph: Graph): string | undefined {
  const id = node.data.item.id;
  if (!ABORT_ID_PATTERN.test(id)) {
    return 'The id can use letters, digits, dash or underscore';
  }
  return allAbortIds(graph).filter((other) => other === id).length > 1
    ? 'Another abort listener uses this id'
    : undefined;
}

/** The `node-abort-trigger` select's options: every watchable trigger, plus the current pick when it is not one. */
function triggerOptions(node: NodeOfKind<'abort'>, graph: Graph): SelectOption[] {
  const options = abortTriggerNodes(graph).map((trigger) => ({
    value: trigger.data.item.id,
    label: `${triggerTitle(trigger.data.item)} · ${trigger.data.item.id}`,
  }));
  const current = node.data.item.triggerId;
  if (current !== '' && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

const SCOPE_OPTIONS: { value: AbortListenerSpec['scope']; label: string }[] = [
  { value: 'queued', label: 'Waiting runs' },
  { value: 'running', label: 'Running runs' },
  { value: 'both', label: 'Both' },
];

/** The abort Inspector described above. */
export function AbortFields({ node, graph, patch }: KindFieldsProps<'abort'>): JSX.Element {
  const { item } = node.data;
  const watchable = abortTriggerNodes(graph);
  const noTriggers = watchable.length === 0;
  return (
    <>
      <Field
        id="node-abort-trigger"
        label="Trigger"
        required
        error={blank(item.triggerId) ? 'Pick the trigger to watch' : undefined}
        hint="Events on this trigger can cancel its runs."
      >
        <Select
          options={triggerOptions(node, graph)}
          value={item.triggerId}
          disabled={noTriggers}
          title={noTriggers ? NO_ABORT_TRIGGER_MESSAGE : undefined}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => patch({ triggerId: event.target.value })}
        />
      </Field>
      <Field
        id="node-abort-when"
        label="Cancel when"
        required
        error={blank(item.when) ? 'Write when an event should cancel runs' : undefined}
        hint="Expression over the incoming event, e.g. event.action == 'closed'."
      >
        <Input
          className="input-mono"
          value={item.when}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ when: event.target.value })}
        />
      </Field>
      <Field
        id="node-abort-match"
        label="Which run"
        required
        error={blank(item.match) ? 'Write how to find the run to cancel' : undefined}
        hint="Expression comparing the event to the run's starting event, e.g. event.pr == run.event.pr."
      >
        <Input
          className="input-mono"
          value={item.match}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ match: event.target.value })}
        />
      </Field>
      <ChoiceField
        id="node-abort-scope"
        label="Cancel"
        value={item.scope}
        options={SCOPE_OPTIONS}
        onChange={(scope) => {
          if (scope !== undefined) patch({ scope });
        }}
      />
      <Field id="node-abort-id" label="Id" required error={idError(node, graph)}>
        <Input
          value={item.id}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ id: event.target.value })}
        />
      </Field>
    </>
  );
}
