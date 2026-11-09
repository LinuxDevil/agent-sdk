/**
 * `KindRules` for `abort` nodes — every `spec.abortListeners` entry
 * (`AbortListenerSpec`): a trigger-correlated cancel rule. `validate`
 * checks the watched trigger exists and is a webhook or channel trigger,
 * that `when`/`match` are non-empty and the id pattern;
 * `duplicateData` gives the copy the next free `a<n>` item id.
 * `watchTrigger` is the `trigger → abort` connect effect `triggerRules`
 * delegates to, so the refusal strings and the watchable-trigger set have
 * one definition (it lives here rather than in `mutations.ts` because
 * kind files cannot import it — that would close an import cycle).
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { nextItemId } from '../nodeIds';
import { arrayItemSpecPath } from '../order';
import { SPEC_ID_PATTERN } from '../specTypes';
import type { TriggerSpec } from '../specTypes';
import type {
  AbortNodeData,
  Graph,
  GraphNode,
  NodeOfKind,
  Problem,
  TriggerNodeData,
} from '../types';

/**
 * The `item.id` rule the Inspector and the validator share — the SDK's
 * `specIdSchema` pattern (`SPEC_ID_PATTERN`), re-exported through
 * `specTypes`, so the canvas flags exactly the ids a spec cannot carry.
 */
export const ABORT_ID_PATTERN = SPEC_ID_PATTERN;

/** The refusal the connect effect and the validator share for a non-event trigger. */
const ABORT_TRIGGER_MESSAGE = 'Abort listeners work with webhook and channel triggers';

/** The palette/Inspector refusal when the graph has no webhook or channel trigger to watch. */
export const NO_ABORT_TRIGGER_MESSAGE = 'Add a webhook or channel trigger first';

/** Only event triggers (an inbound HTTP call or channel message) can cancel runs. */
function isAbortTriggerType(type: string): boolean {
  return type === 'webhook' || type === 'channel';
}

/**
 * Every live `abort` node's `item.id` — the `taken` set for
 * `nextItemId('a', …)` when the palette entry or a duplicate names a new
 * listener (ids are unique across the whole graph, per the
 * `duplicateItemIds` core check).
 */
export function allAbortIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'abort' && n.proposed !== 'remove')
    .map((n) => (n.data as AbortNodeData).item.id);
}

/** The live `trigger` nodes an abort listener may watch: webhook and channel only. */
export function abortTriggerNodes(graph: Graph): NodeOfKind<'trigger'>[] {
  return graph.nodes.filter(
    (n): n is NodeOfKind<'trigger'> =>
      n.kind === 'trigger' &&
      n.proposed !== 'remove' &&
      isAbortTriggerType((n.data as TriggerNodeData).item.type)
  );
}

/** The `item` of the live trigger node whose `item.id` is `id`, if any. */
export function triggerItemById(graph: Graph, id: string): TriggerSpec | undefined {
  const node = graph.nodes.find(
    (n) =>
      n.kind === 'trigger' &&
      n.proposed !== 'remove' &&
      (n.data as TriggerNodeData).item.id === id
  );
  return node === undefined ? undefined : (node.data as TriggerNodeData).item;
}

/** `PaletteEntry.unavailable` for the abort entry: the reason, or `undefined` when a watchable trigger exists. */
export function abortUnavailableReason(graph: Graph): string | undefined {
  return abortTriggerNodes(graph).length === 0 ? NO_ABORT_TRIGGER_MESSAGE : undefined;
}

/**
 * The `trigger → abort` connect effect: rewires the listener's `triggerId`
 * to the dragged trigger. Refuses a trigger type that cannot cancel runs
 * and a re-drag of the trigger already watched.
 */
export function watchTrigger(graph: Graph, abortId: string, trigger: TriggerSpec): ConnectResult {
  const node = graph.nodes.find((n) => n.id === abortId);
  if (node === undefined || node.kind !== 'abort') {
    return { ok: false, reason: `Unknown abort listener '${abortId}'` };
  }
  const item = (node.data as AbortNodeData).item;
  if (!isAbortTriggerType(trigger.type)) return { ok: false, reason: ABORT_TRIGGER_MESSAGE };
  if (item.triggerId === trigger.id) {
    return { ok: false, reason: 'This listener already watches this trigger' };
  }
  return {
    ok: true,
    graph: {
      ...graph,
      nodes: graph.nodes.map(
        (n) =>
          (n.id === abortId
            ? { ...n, data: { item: { ...item, triggerId: trigger.id } } }
            : n) as GraphNode
      ),
    },
  };
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The `AbortListenerSpec` validation rows, in the ticket's order. */
function abortProblems(node: NodeOfKind<'abort'>, graph: Graph): Problem[] {
  const { item } = node.data;
  const path = arrayItemSpecPath(graph, node, 'abortListeners');
  const problems: Problem[] = [];
  const fail = (field: string, message: string): void => {
    problems.push({ nodeId: node.id, severity: 'error', message, fieldPath: `${path}.${field}` });
  };
  if (blank(item.triggerId)) {
    fail('triggerId', 'Pick the trigger this listener watches');
  } else {
    const trigger = triggerItemById(graph, item.triggerId);
    if (trigger === undefined) {
      fail('triggerId', `There is no trigger '${item.triggerId}'`);
    } else if (!isAbortTriggerType(trigger.type)) {
      fail('triggerId', ABORT_TRIGGER_MESSAGE);
    }
  }
  if (blank(item.when)) fail('when', 'Write when an event should cancel runs');
  if (blank(item.match)) fail('match', 'Write how to match the run to cancel');
  if (!ABORT_ID_PATTERN.test(item.id ?? '')) {
    fail('id', 'The id can use letters, digits, dash or underscore');
  }
  return problems;
}

/**
 * `abort` kind rules: validation plus the duplicate's fresh `a<n>` id. The
 * `trigger → abort` connect effect lives in {@link watchTrigger}, called
 * from `triggerRules.connectFrom`; `CONNECTION_RULES.abort` stays empty —
 * a listener is never an edge source.
 */
export const abortRules: KindRules<'abort'> = {
  validate: abortProblems,
  duplicateData: (node, graph) => ({
    item: {
      ...structuredClone(node.data.item),
      id: nextItemId('a', allAbortIds(graph)),
    },
  }),
};
