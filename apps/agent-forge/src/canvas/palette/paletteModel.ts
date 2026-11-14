/**
 * The pure half of the Nodes palette (C18): how registered `PaletteEntry`s
 * group into sections and how the search box filters them. Kept free of
 * React and the canvas so the ordering and matching rules are unit-testable.
 */
import type { Graph } from '../../graph/v2/types';
import type { KIND_VIEWS, PaletteEntry, PaletteGroup } from '../kinds';

/** The fixed palette groups, in the order the Nodes tab renders them. */
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'Start',
  'Agents',
  'Capabilities',
  'Safety',
  'Output',
  'Flow',
  'Canvas',
];

/** One palette group and its entries, in registration order. */
export interface PaletteSection {
  group: PaletteGroup;
  entries: PaletteEntry[];
}

/**
 * All entries from `KIND_VIEWS`, grouped in `PALETTE_GROUP_ORDER`, entries
 * in registration order; empty groups are dropped.
 */
export function paletteSections(views: typeof KIND_VIEWS): PaletteSection[] {
  const all = Object.values(views).flatMap((view) => view?.palette ?? []);
  return PALETTE_GROUP_ORDER.map((group) => ({
    group,
    entries: all.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/** Lowercased label + description + keywords — the text a search term can hit. */
function entryHaystack(entry: PaletteEntry): string {
  return [entry.label, entry.description, ...(entry.keywords ?? [])].join(' ').toLowerCase();
}

/**
 * Case-insensitive match on label, description and keywords; every
 * whitespace-separated term of `query` must appear (so "mcp tool" finds the
 * MCP entry only when both words match). An empty query returns `sections`
 * unchanged; groups left with no entries are dropped.
 */
export function filterPalette(sections: PaletteSection[], query: string): PaletteSection[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return sections;
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => {
        const haystack = entryHaystack(entry);
        return terms.every((term) => haystack.includes(term));
      }),
    }))
    .filter((section) => section.entries.length > 0);
}

/**
 * The display name of the agent a palette add lands in: an inline subagent's
 * key, else its `name` field ('(unnamed)' when blank), else the node id for
 * anything unexpected. `null` owner (notes) reads as 'the canvas'.
 */
export function paletteOwnerTitle(graph: Graph, ownerId: string | null): string {
  if (ownerId === null) return 'the canvas';
  const node = graph.nodes.find((n) => n.id === ownerId);
  if (node?.kind === 'agent') {
    const data = node.data;
    return data.subagentKey ?? (data.fields.name || '(unnamed)');
  }
  return ownerId;
}
