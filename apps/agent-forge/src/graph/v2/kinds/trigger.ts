/**
 * `KindRules` for `trigger` nodes — every `spec.triggers` entry
 * (`TriggerSpec`: chat, cron, webhook, channel or agent chain). `validate`
 * checks the id pattern, the cron expression and time zone, the webhook
 * path and its uniqueness, required prompt(promptTemplate)s, the channel's
 * required secret keys and the chain target, and warns on a second chat
 * trigger. No `connectFrom`: `trigger → agent` is always refused (the
 * `starts` edge is derived) and `trigger → abort` takes the default effect
 * until C16. `duplicateData` gives the copy a fresh `t<n>` id and, for a
 * webhook, a `-copy` path.
 */
import { nextItemId } from '../nodeIds';
import { arrayItemSpecPath, sectionChildren } from '../order';
import { CHANNEL_SECRET_KEYS } from '../specTypes';
import type { ChannelKind, TriggerSpec } from '../specTypes';
import type { KindRules } from '../kindRules';
import type { Graph, NodeOfKind, Problem, TriggerNodeData } from '../types';
import { ROOT_AGENT_ID } from '../types';

/**
 * The required `secrets` keys per channel kind — the SDK's own list from
 * `src/spec/v2/triggers.ts` (the channel factories' credential option
 * names), re-exported through `specTypes` so the Inspector's prefill and
 * this validator check the same keys the spec schema enforces.
 */
export { CHANNEL_SECRET_KEYS };

/**
 * The display label of a channel kind — the card title (`Slack`), the
 * Inspector's channel options and the validator's `<Channel>` in
 * "needs the '<key>' secret" all share it.
 */
export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  github: 'GitHub',
  teams: 'Teams',
  discord: 'Discord',
  http: 'HTTP',
};

/**
 * The id rule the Inspector and the validator share. The canvas holds the
 * stricter form — `^[A-Za-z0-9_-]{1,64}$` without dots — so node ids stay
 * inside the characters `trigger:<id>` node ids already produce.
 */
export const TRIGGER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The webhook `path` rule the Inspector and the validator share: a leading `/` then path characters. */
export const WEBHOOK_PATH_PATTERN = /^\/[A-Za-z0-9/_-]*$/;

/**
 * The cron-expression check the Inspector and the validator share: five
 * space-separated fields of cron characters (`0 9 * * 1-5`). The SDK also
 * accepts `@daily`-style shortcuts; the form deliberately teaches the
 * five-field shape instead.
 */
export function isCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[0-9*/,-A-Za-z]+$/.test(field));
}

/** Whether `timeZone` is an IANA name `Intl` accepts — try constructing a formatter rather than keeping a zone list. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `item.id`s of the live trigger nodes — the `taken` set for
 * `nextItemId('t', …)` when the palette or a duplicate names a new trigger
 * (trigger ids are unique across the graph: the spec schema rejects a
 * repeated one and `validateGraph`'s duplicate-id core check flags it).
 */
export function triggerSiblingIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'trigger' && n.proposed !== 'remove')
    .map((n) => (n.data as TriggerNodeData).item.id);
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The live trigger siblings of `node` (its section-mates under the root agent). */
function siblings(node: NodeOfKind<'trigger'>, graph: Graph): NodeOfKind<'trigger'>[] {
  return sectionChildren(graph, node.owner ?? ROOT_AGENT_ID, 'triggers') as NodeOfKind<'trigger'>[];
}

/** A `chat` trigger sibling listed before `node` exists — the node is the extra one. */
function earlierChatExists(node: NodeOfKind<'trigger'>, graph: Graph): boolean {
  for (const sibling of siblings(node, graph)) {
    if (sibling.id === node.id) return false;
    if (sibling.data.item.type === 'chat') return true;
  }
  return false;
}

/** Another live webhook trigger carries `item.path` — two triggers would answer the same POST. */
function webhookPathClash(node: NodeOfKind<'trigger'>, graph: Graph, path: string): boolean {
  return siblings(node, graph).some(
    (sibling) =>
      sibling.id !== node.id && sibling.data.item.type === 'webhook' && sibling.data.item.path === path
  );
}

type Fail = (severity: Problem['severity'], field: string | null, message: string) => void;

/** The `cron` variant's rules, in the ticket's order. */
function cronProblems(item: Extract<TriggerSpec, { type: 'cron' }>, fail: Fail): void {
  if (!isCron(item.cron ?? '')) {
    fail('error', 'cron', 'Use five cron fields: minute hour day month weekday');
  }
  if (blank(item.prompt)) fail('error', 'prompt', 'A schedule needs a prompt');
  if (typeof item.timezone === 'string' && item.timezone !== '' && !isTimeZone(item.timezone)) {
    fail('error', 'timezone', `Unknown time zone '${item.timezone}'`);
  }
}

/** The `webhook` variant's rules: the path shape, its uniqueness, the required prompt template. */
function webhookProblems(
  node: NodeOfKind<'trigger'>,
  graph: Graph,
  fail: Fail
): void {
  const item = node.data.item;
  if (item.type !== 'webhook') return;
  if (!WEBHOOK_PATH_PATTERN.test(item.path ?? '')) {
    fail('error', 'path', 'Webhook paths start with / and use letters, digits, dash or underscore');
  } else if (webhookPathClash(node, graph, item.path)) {
    fail('error', 'path', `Two webhooks use the path '${item.path}'`);
  }
  if (blank(item.promptTemplate)) fail('error', 'promptTemplate', 'Enter a prompt template');
}

/** The `channel` variant's rule: a SecretRef for every key the channel kind requires. */
function channelProblems(item: Extract<TriggerSpec, { type: 'channel' }>, fail: Fail): void {
  const secrets = item.secrets ?? {};
  const label = CHANNEL_LABELS[item.channel] ?? item.channel;
  for (const key of CHANNEL_SECRET_KEYS[item.channel] ?? []) {
    if (!(key in secrets)) fail('error', `secrets.${key}`, `${label} needs the '${key}' secret`);
  }
}

/** The `agent` chain variant's rules: a target and a prompt template. */
function agentProblems(item: Extract<TriggerSpec, { type: 'agent' }>, fail: Fail): void {
  if (blank(item.after)) fail('error', 'after', 'Pick the agent this follows');
  if (blank(item.promptTemplate)) fail('error', 'promptTemplate', 'Enter a prompt template');
}

/** The `TriggerSpec` form's validation rows: the id pattern, the per-type rows, then the chat warning. */
function triggerProblems(node: NodeOfKind<'trigger'>, graph: Graph): Problem[] {
  const { item } = node.data;
  const path = arrayItemSpecPath(graph, node, 'triggers');
  const problems: Problem[] = [];
  const fail: Fail = (severity, field, message) => {
    problems.push({
      nodeId: node.id,
      severity,
      message,
      fieldPath: field === null ? path : `${path}.${field}`,
    });
  };
  if (!TRIGGER_ID_PATTERN.test(item.id ?? '')) {
    fail('error', 'id', 'The id can use letters, digits, dash or underscore');
  }
  switch (item.type) {
    case 'chat':
      if (earlierChatExists(node, graph)) fail('warning', null, 'One chat trigger is enough');
      break;
    case 'cron':
      cronProblems(item, fail);
      break;
    case 'webhook':
      webhookProblems(node, graph, fail);
      break;
    case 'channel':
      channelProblems(item, fail);
      break;
    case 'agent':
      agentProblems(item, fail);
      break;
    default:
      // A catalog type outside the five PLAN kinds: validated where it runs.
      break;
  }
  return problems;
}

/**
 * `trigger` kind rules: validation plus the duplicate naming rule. No
 * `connectFrom` — `trigger → agent` is refused by `canConnect` (the
 * `starts` edge is derived) and `trigger → abort`'s effect lands with C16.
 */
export const triggerRules: KindRules<'trigger'> = {
  validate: triggerProblems,
  duplicateData: (node, graph) => {
    const item = structuredClone(node.data.item);
    item.id = nextItemId('t', triggerSiblingIds(graph));
    if (item.type === 'webhook') item.path = `${item.path}-copy`;
    return { item };
  },
};
