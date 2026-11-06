/**
 * The `KindView` for `subagent` nodes — the `{ ref }` and `{ remote }`
 * entries of `spec.subagents` (inline entries render as `agent` groups).
 * The card's title is the record key, its chip the source kind, and its
 * rows the ref target or the remote host plus auth. `Fields` is the
 * subagent Inspector (`subagent/SubagentFields.tsx`); the palette offers
 * the ref and remote entries (the inline "Subagent" entry lives on the
 * `agent` view — it creates an `agent` node).
 */
import { Users } from 'lucide-react';
import { uniqueName } from '../../graph/v2/nodeIds';
import { subagentSiblingKeys } from '../../graph/v2/order';
import type { SecretRef } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { SubagentFields } from './subagent/SubagentFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The display name of a ref target: `agents/billing.yaml` → `billing`; anything else is shown verbatim. */
function refName(ref: string): string {
  return ref.replace(/^agents\//, '').replace(/\.yaml$/, '');
}

/** The host part of `url`, or the raw string when it does not parse. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `env:NAME`, `secret:NAME` or `none` for the remote's auth row. */
function authText(auth: SecretRef | undefined): string {
  if (auth === undefined) return 'none';
  return 'env' in auth ? `env:${auth.env}` : `secret:${auth.secret}`;
}

/** The card rows, in the ticket's order. */
function rows(node: NodeOfKind<'subagent'>): NodeRow[] {
  const { item } = node.data;
  if ('ref' in item) return [{ k: 'agent', v: refName(item.ref) }];
  return [
    { k: 'url', v: urlHost(item.remote.url) },
    { k: 'auth', v: authText(item.remote.auth) },
  ];
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'subagent-ref',
    group: 'Agents',
    label: 'Existing agent as subagent',
    description: 'Delegates to another agent',
    kind: 'subagent',
    create: (graph, owner) => ({
      kind: 'subagent',
      data: { key: uniqueName('helper', subagentSiblingKeys(graph, owner)), item: { ref: '' } },
    }),
  },
  {
    id: 'subagent-remote',
    group: 'Agents',
    label: 'Remote agent',
    description: 'Delegates over HTTP',
    kind: 'subagent',
    create: (graph, owner) => ({
      kind: 'subagent',
      data: {
        key: uniqueName('remote', subagentSiblingKeys(graph, owner)),
        item: { remote: { url: '', description: '' } },
      },
    }),
  },
];

/** The `subagent` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const SUBAGENT_VIEW: KindView<'subagent'> = {
  label: 'Subagent',
  tone: 'violet',
  Icon: Users,
  title: (node) => node.data.key,
  chip: (node) => ('ref' in node.data.item ? 'agent' : 'remote'),
  rows,
  ports: { in: true, out: false },
  Fields: SubagentFields,
  palette: PALETTE,
};
