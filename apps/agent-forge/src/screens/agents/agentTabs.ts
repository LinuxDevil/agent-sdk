import { matchRoute } from '../../router/router';

/** The agent detail tabs, in the order the tab bar shows them. */
export const AGENT_TABS = ['overview', 'canvas', 'configure', 'code', 'runs', 'versions', 'suggestions'] as const;

/** A tab of the agent detail screen (`#/agents/:id/<tab>`). */
export type AgentTab = (typeof AGENT_TABS)[number];

/** The tab bar's label for each tab. */
export const AGENT_TAB_LABELS: Record<AgentTab, string> = {
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
