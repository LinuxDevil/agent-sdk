/**
 * The Templates screen's pure helpers (A10): the "Needs …" line a card and
 * the detail sheet share, and the category pill counts. Kept React-free so
 * the screen and its tests share them.
 */
import type { TemplateSummary } from '../../../shared/wireTypes';

/** What each `requires` kind asks the user for, as the lower-case noun phrase the "Needs" line joins. */
export const REQUIRE_LABELS: Record<TemplateSummary['requires'][number], string> = {
  provider_key: 'a model API key',
  secret: 'a secret',
  mcp: 'an MCP server',
  tool: 'tool credentials',
  model: 'a specific model',
};

/**
 * 'Needs a model API key and an MCP server.' — '' when nothing is required.
 * The list joins Oxford-free: 'a, b and c'.
 */
export function requiresLine(requires: TemplateSummary['requires']): string {
  if (requires.length === 0) return '';
  const labels = requires.map((kind) => REQUIRE_LABELS[kind]);
  const joined =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Needs ${joined}.`;
}

/** One category pill: `value` is the `?category=` value (`undefined` for All), `label` its text, `count` its templates. */
export interface CategoryCount {
  value: string | undefined;
  label: string;
  count: number;
}

/** Categories with counts, sorted by name; 'All' first with the total. */
export function categoryCounts(items: TemplateSummary[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: undefined, label: 'All', count: items.length }, ...categories];
}
