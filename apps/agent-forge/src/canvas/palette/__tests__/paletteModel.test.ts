import { describe, expect, it } from 'vitest';
import { filterPalette, paletteOwnerTitle, paletteSections, PALETTE_GROUP_ORDER } from '../paletteModel';
import { KIND_VIEWS } from '../../kinds';
import type { PaletteEntry, PaletteGroup } from '../../kinds';
import type { Graph } from '../../../graph/v2/types';

type Views = Parameters<typeof paletteSections>[0];

/** A minimal palette entry; `create` is never invoked by the model. */
function entry(
  id: string,
  group: PaletteGroup,
  label = id,
  description = '',
  keywords?: string[],
): PaletteEntry {
  return {
    id,
    group,
    label,
    description,
    keywords,
    kind: 'tool',
    create: () => ({ kind: 'tool', data: { item: { builtin: 'x' } } }),
  };
}

/** A `KIND_VIEWS`-shaped stub: only the `palette` field matters to the model. */
function viewsWith(palette: PaletteEntry[]): Views {
  return { tool: { palette } } as unknown as Views;
}

describe('paletteSections', () => {
  it('groups entries in PALETTE_GROUP_ORDER, keeps registration order and drops empty groups', () => {
    const sections = paletteSections(
      viewsWith([
        entry('e-canvas', 'Canvas'),
        entry('e-safety-2', 'Safety', 'Second'),
        entry('e-start', 'Start'),
        entry('e-safety-1', 'Safety', 'First'),
        entry('e-agents', 'Agents'),
      ]),
    );
    expect(sections.map((s) => s.group)).toEqual(['Start', 'Agents', 'Safety', 'Canvas']);
    expect(sections.find((s) => s.group === 'Safety')?.entries.map((e) => e.id)).toEqual([
      'e-safety-2',
      'e-safety-1',
    ]);
    for (const section of sections) {
      expect(PALETTE_GROUP_ORDER).toContain(section.group);
    }
  });

  it('collects entries across every registered kind view', () => {
    const sections = paletteSections(KIND_VIEWS);
    expect(sections.length).toBeGreaterThan(0);
    const ids = sections.flatMap((s) => s.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Groups still render in the fixed order.
    const order = sections.map((s) => PALETTE_GROUP_ORDER.indexOf(s.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('filterPalette', () => {
  const sections = paletteSections(
    viewsWith([
      entry('tool', 'Capabilities', 'Tool', 'Runs a built-in tool', ['function', 'api']),
      entry('mcp', 'Capabilities', 'MCP server', 'Tools from an MCP server', ['server', 'plugin']),
      entry('perm', 'Safety', 'Permission rule', 'Allows, denies or asks per tool', ['approval', 'allow', 'deny']),
    ]),
  );

  it('returns the sections unchanged for an empty or blank query', () => {
    expect(filterPalette(sections, '')).toBe(sections);
    expect(filterPalette(sections, '   ')).toBe(sections);
  });

  it('matches case-insensitively on label and description', () => {
    const result = filterPalette(sections, 'BUILT-IN');
    expect(result.flatMap((s) => s.entries.map((e) => e.id))).toEqual(['tool']);
  });

  it('matches keywords', () => {
    const result = filterPalette(sections, 'plugin');
    expect(result.flatMap((s) => s.entries.map((e) => e.id))).toEqual(['mcp']);
  });

  it('requires every whitespace-separated term to match', () => {
    const result = filterPalette(sections, 'mcp server');
    expect(result.flatMap((s) => s.entries.map((e) => e.id))).toEqual(['mcp']);
    expect(filterPalette(sections, 'mcp perm')).toEqual([]);
  });

  it('drops groups left with no matching entries', () => {
    const result = filterPalette(sections, 'approval');
    expect(result.map((s) => s.group)).toEqual(['Safety']);
  });
});

describe('paletteOwnerTitle', () => {
  const agent = (data: Record<string, unknown>, id = 'agent') => ({
    id,
    kind: 'agent' as const,
    owner: null,
    position: { x: 0, y: 0 },
    data,
  });
  const graph = (nodes: ReturnType<typeof agent>[]): Graph =>
    ({ version: 2, nodes, emptySections: [], unplaced: [] }) as unknown as Graph;

  it('names an inline subagent by its key and a named agent by its name', () => {
    expect(
      paletteOwnerTitle(graph([agent({ fields: { name: 'x' }, extra: {}, subagentKey: 'helper' }, 'sub:helper')]), 'sub:helper'),
    ).toBe('helper');
    expect(paletteOwnerTitle(graph([agent({ fields: { name: 'Root' }, extra: {} })]), 'agent')).toBe('Root');
  });

  it('falls back to (unnamed) and to the canvas for a null owner', () => {
    expect(paletteOwnerTitle(graph([agent({ fields: { name: '' }, extra: {} })]), 'agent')).toBe('(unnamed)');
    expect(paletteOwnerTitle(graph([]), null)).toBe('the canvas');
  });
});
