import { matchRoute } from '../../router/router';
import { WORKSPACE_ID_RE } from '../../../shared/workspace';
import { activeWorkspace } from '../../workspace/activeWorkspace';
import type { TabItem } from '../../ui/Tabs';

/** The agent detail tabs, in the order the tab bar shows them. */
const AGENT_TABS = ['overview', 'canvas', 'configure', 'code', 'runs', 'versions', 'suggestions'] as const;

/** A tab of the agent detail screen (`#/w/<ws>/agents/<id>/<tab>`). */
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
 * the detail screen's first tab (A05), 'runs' its runs table (A11);
 * 'configure' its form view (A07), 'code' the generated-code tab (A08);
 * 'versions' is the detail screen's version timeline (L01), 'suggestions'
 * its pending-draft review (L11b; R06 adds suggestion cards). An unbuilt
 * tab's URL redirects to canvas.
 */
export const BUILT_AGENT_TABS: ReadonlySet<AgentTab> = new Set<AgentTab>(['canvas', 'overview', 'configure', 'code', 'runs', 'versions', 'suggestions']);

/** Whether `s` names an agent detail tab. */
export function isAgentTab(s: string): s is AgentTab {
  return (AGENT_TABS as readonly string[]).includes(s);
}

/**
 * The hash path of one agent tab: `/w/<ws>/agents/<encoded id>/<tab>`.
 * `ws` defaults to `activeWorkspace()` (the URL's `#/w/` segment, else the
 * launch workspace); with no workspace known yet the legacy
 * `/agents/<id>/<tab>` shape comes out and `agentRedirect` fixes it up
 * once `GET /workspaces` answers.
 */
export function agentTabPath(id: string, tab: AgentTab, ws?: string): string {
  const agent = `/agents/${encodeURIComponent(id)}/${tab}`;
  const workspace = ws ?? activeWorkspace();
  return workspace === undefined ? agent : `/w/${encodeURIComponent(workspace)}${agent}`;
}

/** `/w/<ws>/agents` for one workspace's list, `/agents` (every workspace) when `ws` is undefined. */
export function agentListPath(ws?: string): string {
  return ws === undefined ? '/agents' : `/w/${encodeURIComponent(ws)}/agents`;
}

/** The tab an agents URL should show: a built tab name, else 'canvas'. */
function settledTab(tab: string | undefined): AgentTab {
  return tab !== undefined && isAgentTab(tab) && BUILT_AGENT_TABS.has(tab) ? tab : 'canvas';
}

/** The agents URL patterns `agentRedirect` rewrites, in match order (first match wins). */
const AGENTS_PATTERNS = [
  '/agents/:id',
  '/agents/:id/:tab',
  '/w/:ws/agents',
  '/w/:ws/agents/:id',
  '/w/:ws/agents/:id/:tab',
] as const;

/**
 * Where an agents URL must go instead, or `null` to stay (the hash's query
 * string is preserved on every redirect):
 *
 * - `/agents/:id` and `/agents/:id/:tab` (pre-W04b links) →
 *   `/w/<launchId>/agents/:id/<tab|canvas>`; `null` while `launchId` is
 *   still unknown so the caller waits for `GET /workspaces`.
 * - `/w/<ws>/agents/:id` → `/w/<ws>/agents/:id/canvas`.
 * - `/w/<ws>/agents/:id/:tab` with an unknown or unbuilt tab →
 *   `/w/<ws>/agents/:id/canvas`.
 * - `/w/<ws>/…` with a `ws` that fails `WORKSPACE_ID_RE` → `/agents`.
 */
export function agentRedirect(hash: string, launchId: string | undefined): string | null {
  const route = matchRoute(hash, [...AGENTS_PATTERNS]);
  if (route === null) return null;
  const { id, tab, ws } = route.params;
  const qs = route.query.toString();
  const withQuery = (target: string) => (qs === '' ? target : `${target}?${qs}`);

  if (ws !== undefined) {
    // '/w/<ws>/agents' and '/w/<ws>/agents/:id…' rows: an id that is not a
    // workspace id sends the whole URL back to the all-workspaces list.
    if (!WORKSPACE_ID_RE.test(ws)) return withQuery('/agents');
    if (id === undefined) return null; // the workspace's agent list stays
    return tab === undefined || settledTab(tab) !== tab
      ? withQuery(`/w/${encodeURIComponent(ws)}/agents/${encodeURIComponent(id)}/canvas`)
      : null;
  }

  // Legacy '/agents/:id…' rows: they can only resolve once the launch
  // workspace is known.
  if (launchId === undefined) return null;
  const settled = settledTab(tab);
  return withQuery(`/w/${encodeURIComponent(launchId)}/agents/${encodeURIComponent(id)}/${settled}`);
}

/**
 * The tab strip's items for agent `id`, in `AGENT_TABS` order: every tab is
 * a hash link to its `agentTabPath`, unbuilt tabs disabled with the shared
 * "Coming in a later release" reason. `counts` adds a pill to a tab (the
 * Suggestions tab's pending-draft count, L11b). Shared by the detail
 * header (A05) and the builder's tab strip (A12).
 */
export function agentTabItems(id: string, counts?: Partial<Record<AgentTab, number>>): TabItem[] {
  return AGENT_TABS.map((t) => ({
    id: t,
    label: AGENT_TAB_LABELS[t],
    href: `#${agentTabPath(id, t)}`,
    count: counts?.[t] || undefined,
    disabled: !BUILT_AGENT_TABS.has(t),
    disabledReason: 'Coming in a later release',
  }));
}
