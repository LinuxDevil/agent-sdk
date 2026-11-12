import { useEffect, type ReactNode } from 'react';
import { matchRoute, navigate } from '../router/router';
import { useRoute } from '../router/useRoute';
import { ScreenHeader, ScreenHeaderHost } from '../shell/ScreenHeader';
import { SettingsPanel } from '../components/SettingsPanel';
import { TracesScreen } from './traces/TracesScreen';
import { ThreadsScreen } from './threads/ThreadsScreen';
import { PromptsScreen } from './prompts/PromptsScreen';
import { HubScreen } from './hub/HubScreen';
import { AgentsScreen } from './agents/AgentsScreen';
import { AgentListScreen } from './agentList/AgentListScreen';
import { AgentDetailRoute } from './agentDetail/AgentDetailRoute';
import { TemplatesScreen } from './templates/TemplatesScreen';
import { agentRedirect } from './agents/agentTabs';
import { TraceScreen } from './traces/TraceScreen';
import { MonitoringScreen } from './monitoring/MonitoringScreen';
import { ScoresScreen } from './scores/ScoresScreen';
import { DatasetsScreen } from './datasets/DatasetsScreen';
import { QueuesScreen } from './queues/QueuesScreen';
import { EvaluatorsScreen } from './evaluators/EvaluatorsScreen';
import { PlaygroundRoute } from './playground/PlaygroundScreen';
import { WorkspacesScreen } from './workspaces/WorkspacesScreen';
import { WorkspaceRoute } from './workspaces/WorkspaceRoute';
import { WorkspacesClientProvider } from './workspaces/workspacesClient';
import { useLeaveAgentsGuard } from './agents/useLeaveAgentsGuard';
import { ROUTES, type ScreenId } from './routeTable';

/** The screen a hash shows, or `null` for an empty hash / unknown route. */
export function screenFor(hash: string): ScreenId | null {
  for (const { pattern, screen } of ROUTES) if (matchRoute(hash, [pattern])) return screen;
  return null;
}

/**
 * The current screen. An agents URL `agentRedirect` rewrites (the legacy
 * `#/agents/:id` builder URL, a tab that is unknown or not built yet) is
 * replaced by its canvas URL - only the hash changes, so a `?token=` from
 * `lousho studio` survives - and the builder shows meanwhile. An empty hash or
 * unknown route is replaced by `#/agents` (the list) and shows it meanwhile.
 */
export function useScreen(): ScreenId {
  const { path } = useRoute();
  const screen = screenFor(`#${path}`);
  const redirect = agentRedirect(window.location.hash);
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { replace: true });
    else if (screen === null) navigate('/agents', { replace: true });
  }, [redirect, screen]);
  if (redirect !== null) return 'agents';
  return screen ?? 'agentList';
}

/** `#/traces/:traceId`: the trace id comes from the hash; a new id remounts the screen. */
function TraceRoute() {
  const { path } = useRoute();
  const traceId = matchRoute(`#${path}`, ['/traces/:traceId'])?.params.traceId ?? '';
  return <TraceScreen key={traceId} traceId={traceId} />;
}

/**
 * Every screen but Agents: the shell's ScreenHeader (its h1 is the page's h1) over the
 * screen's content. A screen may render its own `<ScreenHeader … />` to replace the default.
 */
function ScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app app-screen">
      <ScreenHeaderHost>
        <main className="screen-main">{children}</main>
      </ScreenHeaderHost>
    </div>
  );
}

/** The screens that render with no props, by id (Agents and Settings are handled in `Screens`). */
const SCREENS: Partial<Record<ScreenId, () => ReactNode>> = {
  agentList: AgentListScreen,
  templates: TemplatesScreen,
  traces: TracesScreen,
  trace: TraceRoute,
  monitoring: MonitoringScreen,
  scores: ScoresScreen,
  datasets: DatasetsScreen,
  queues: QueuesScreen,
  evaluators: EvaluatorsScreen,
  playground: PlaygroundRoute,
  threads: ThreadsScreen,
  prompts: PromptsScreen,
  hub: HubScreen,
  workspaces: () => (
    <WorkspacesClientProvider>
      <WorkspacesScreen />
    </WorkspacesClientProvider>
  ),
};

const SETTINGS_DESCRIPTION = 'Appearance, provider keys, profiles and the collector for this Studio.';

/** Renders the screen the hash route names; leaving Agents with unsaved changes asks first. */
export function Screens() {
  const screen = useLeaveAgentsGuard(useScreen());
  if (screen === 'agents') return <AgentsScreen />;
  // The detail header is the page's header: no ScreenFrame around it (A05).
  if (screen === 'agentDetail') return <AgentDetailRoute />;
  if (screen === 'workspace')
    return (
      <WorkspacesClientProvider>
        <WorkspaceRoute />
      </WorkspacesClientProvider>
    );

  const Screen = SCREENS[screen];
  let content: ReactNode;
  if (Screen) content = <Screen />;
  else
    content = (
      <div className="screen-settings">
        <ScreenHeader title="Settings" description={SETTINGS_DESCRIPTION} />
        <h2 className="visually-hidden">Settings</h2>
        <SettingsPanel variant="screen" />
      </div>
    );
  return <ScreenFrame>{content}</ScreenFrame>;
}
