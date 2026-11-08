import type { LucideIcon } from 'lucide-react';
import { Box } from 'lucide-react';
import type { NewNode } from '../../graph/v2/mutations';
import type { Graph, NodeKind, NodeOfKind, Problem } from '../../graph/v2/types';
import { AGENT_VIEW } from './agent';
import { GUARDRAIL_VIEW } from './guardrail';
import { HANDOFF_VIEW } from './handoff';
import { HOOK_VIEW } from './hook';
import { MCP_VIEW } from './mcp';
import { MEMORY_VIEW } from './memory';
import { NOTE_VIEW } from './note';
import { OUTPUT_VIEW } from './output';
import { PERMISSION_VIEW } from './permission';
import { SKILL_VIEW } from './skill';
import { SUBAGENT_VIEW } from './subagent';
import { TOOL_VIEW } from './tool';
import { TRIGGER_VIEW } from './trigger';
import { GenericFields } from './GenericFields';

/** A kind tile's colour family: `kind-<tone>` in screens/agents/agents.css (also the MiniMap's node fill). */
export type KindTone = 'accent' | 'violet' | 'info' | 'warning' | 'success' | 'neutral';

/** The fixed palette groups; their render order lives in `canvas/palette/paletteModel.ts` (`PALETTE_GROUP_ORDER`, C18). */
export type PaletteGroup = 'Start' | 'Agents' | 'Capabilities' | 'Safety' | 'Output' | 'Flow' | 'Canvas';

/** One key/value row under a node card's title (`.node-row` in agents.css). */
export interface NodeRow {
  k: string;
  v: string;
}

/**
 * One entry of a kind's palette list (`view.palette`). The drag payload is
 * `id` (kebab, unique across every registered kind); `create` builds the
 * default spec data for a node dropped (or activated) under `owner`.
 */
export interface PaletteEntry {
  /** Unique, kebab, e.g. 'tool', 'subagent-inline'. */
  id: string;
  group: PaletteGroup;
  /** Sentence case. */
  label: string;
  /** ≤ 40 chars. */
  description: string;
  /** C18's palette search. */
  keywords?: string[];
  /** The kind `create` produces — lets the drop compute `ownerForNewNode` before calling `create`. */
  kind: NodeKind;
  /** Default data for a node of `kind` owned by `owner`. */
  create: (graph: Graph, owner: string | null) => NewNode;
  /** Why this entry cannot be added for `owner` right now, or undefined. Palette shows it disabled with this as title; drop refuses with it. */
  unavailable?: (graph: Graph, owner: string | null) => string | undefined;
}

/** The props every kind's Inspector body (`view.Fields`) receives. */
export interface KindFieldsProps<K extends NodeKind> {
  node: NodeOfKind<K>;
  graph: Graph;
  /** `patchNode(graph, node.id, patch)` through `setGraph`. */
  patch: (patch: Record<string, unknown>) => void;
  /** `setNodeData(graph, node.id, data)` through `setGraph`. */
  replace: (data: NodeOfKind<K>['data']) => void;
  /** `validateGraph(graph)` filtered to this node (C19 fills it; `[]` before). */
  problems: Problem[];
}

/**
 * Everything the canvas needs to draw and edit one node kind: the card
 * head (tile, title, chip, rows, ports) and the Inspector body (`Fields`)
 * plus the palette entries it contributes. Kind tickets (C03–C16)
 * register one `KindView` per kind in `KIND_VIEWS`; before a kind has one,
 * `viewFor` synthesises the generic card + JSON Inspector.
 */
export interface KindView<K extends NodeKind> {
  /** 'Tool', 'MCP server', … used in "Selected node (<label>)". */
  label: string;
  tone: KindTone;
  Icon: LucideIcon;
  /** The card title. */
  title: (node: NodeOfKind<K>) => string;
  /** One mono chip under the title. */
  chip?: (node: NodeOfKind<K>) => string | undefined;
  /** ≤ 4 key/value rows. */
  rows: (node: NodeOfKind<K>) => NodeRow[];
  ports: { in: boolean; out: boolean };
  Fields: (props: KindFieldsProps<K>) => JSX.Element;
  palette: PaletteEntry[];
}

/**
 * The kind registry the canvas reads: one `KindView` per `NodeKind`,
 * contributed by the kind tickets (C03–C16). Starts empty — every kind
 * falls back to `viewFor`'s generic view until its ticket lands.
 */
export const KIND_VIEWS: { [K in NodeKind]?: KindView<K> } = {
  agent: AGENT_VIEW,
  subagent: SUBAGENT_VIEW,
  tool: TOOL_VIEW,
  handoff: HANDOFF_VIEW,
  mcp: MCP_VIEW,
  skill: SKILL_VIEW,
  memory: MEMORY_VIEW,
  trigger: TRIGGER_VIEW,
  guardrail: GUARDRAIL_VIEW,
  permission: PERMISSION_VIEW,
  hook: HOOK_VIEW,
  output: OUTPUT_VIEW,
  note: NOTE_VIEW,
};

/** The fallback `KindView`: bare kind tile, id-suffix title, no rows, both ports, the JSON `GenericFields`. */
function GENERIC_VIEW<K extends NodeKind>(kind: K): KindView<K> {
  return {
    label: kind,
    tone: 'neutral',
    Icon: Box,
    title: (node) => node.id.slice(node.id.lastIndexOf(':') + 1),
    rows: () => [],
    ports: { in: true, out: true },
    Fields: GenericFields as (props: KindFieldsProps<K>) => JSX.Element,
    palette: [],
  };
}

/** `KIND_VIEWS[kind]` when a kind ticket registered one, else the generic fallback view. */
export function viewFor<K extends NodeKind>(kind: K): KindView<K> {
  return (KIND_VIEWS[kind] as KindView<K> | undefined) ?? GENERIC_VIEW(kind);
}
