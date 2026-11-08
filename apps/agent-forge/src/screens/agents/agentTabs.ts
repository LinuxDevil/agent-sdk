import { matchRoute } from '../../router/router';
import type { TabItem } from '../../ui/Tabs';

/** The agent detail tabs, in the order the tab bar shows them. */
const AGENT_TABS = ['overview', 'canvas', 'configure', 'code', 'runs', 'versions', 'suggestions'] as const;

/** A tab of the agent detail screen (`#/agents/:id/<tab>`). */
export type AgentTab = (typeof AGENT_TABS)[number];

/** The tab bar's label for each tab. */
const AGENT_TAB_LABELS: Record<AgentTab, string> = {
  overview: 'Overview',
  canvas: 'Canvas',
  configure: 'Configure',
  code: 'Code',
  runs: 'Runs',
  versions: 'Versions',
  suggestions: 'Suggestions',
};

/**
 * Tabs with a screen behind them. 'canvas' is the builder screen, 'overview'
 * the detail screen's first tab (A05); 'configure' lands in A07, 'code' in
 * A08, 'runs' in A11, 'versions' in L01 and 'suggestions' in R06. An unbuilt
 * tab's URL redirects to canvas.
 */
export const BUILT_AGENT_TABS: ReadonlySet<AgentTab> = new Set<AgentTab>(['canvas', 'overview']);

/** Whether `s` names an agent detail tab. */
export function isAgentTab(s: string): s is AgentTab {
  return (AGENT_TABS as readonly string[]).includes(s);
}

/** The hash path of one agent tab: `/agents/<encoded id>/<tab>`. */
export function agentTabPath(id: string, tab: AgentTab): string {
  return `/agents/${encodeURIComponent(id)}/${tab}`;
}

/**
 * The tab strip's items for agent `id`, in `AGENT_TABS` order: every tab is
 * a hash link to its `agentTabPath`, unbuilt tabs disabled with the shared
 * "Coming in a later release" reason. Shared by the detail header (A05) and
 * the builder's tab strip (A12).
 */
export function agentTabItems(id: string): TabItem[] {
  return AGENT_TABS.map((t) => ({
    id: t,
    label: AGENT_TAB_LABELS[t],
    href: `#${agentTabPath(id, t)}`,
    disabled: !BUILT_AGENT_TABS.has(t),
    disabledReason: 'Coming in a later release',
  }));
}

/**
 * Where an agents URL must go instead, or `null` to stay:
 * `/agents/:id` (the legacy builder URL) and `/agents/:id/:tab` with a tab
 * that is unknown or not built yet both go to `/agents/:id/canvas`.
 * The hash's query string is preserved on the redirect.
 */
export function agentRedirect(hash: string): string | null {
  const route = matchRoute(hash, ['/agents/:id', '/agents/:id/:tab']);
  if (route === null) return null;
  const tab = route.params.tab;
  if (tab !== undefined && isAgentTab(tab) && BUILT_AGENT_TABS.has(tab)) return null;
  const canvas = agentTabPath(route.params.id, 'canvas');
  const qs = route.query.toString();
  return qs === '' ? canvas : `${canvas}?${qs}`;
}
