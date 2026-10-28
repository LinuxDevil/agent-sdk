import { useEffect, type ReactNode } from 'react';
import { matchRoute, navigate } from '../router/router';
import { useRoute } from '../router/useRoute';
import { Topbar } from '../components/Topbar';
import { SettingsPanel } from '../components/SettingsPanel';
import { TracesScreen } from './traces/TracesScreen';
import { ThreadsScreen } from './threads/ThreadsScreen';
import { PromptsScreen } from './prompts/PromptsScreen';
import { HubScreen } from './hub/HubScreen';
import { AgentsScreen } from './agents/AgentsScreen';
import { TraceScreen } from './traces/TraceScreen';
import { MonitoringScreen } from './monitoring/MonitoringScreen';
import { ScoresScreen } from './scores/ScoresScreen';
import { DatasetsScreen } from './datasets/DatasetsScreen';
import { PlaygroundRoute } from './playground/PlaygroundScreen';
import { useLeaveAgentsGuard } from './agents/useLeaveAgentsGuard';
import { Placeholder } from './Placeholder';
import { ROUTES, type ScreenId } from './routeTable';
import { EvalsTabs } from './evals/EvalsTabs';

/** The screen a hash shows, or `null` for an empty hash / unknown route. */
export function screenFor(hash: string): ScreenId | null {
  for (const { pattern, screen } of ROUTES) if (matchRoute(hash, [pattern])) return screen;
  return null;
}

/**
 * The current screen. An empty hash or unknown route is replaced by `#/agents`
 * (only the hash changes, so a `?token=` from `lousho studio` survives) and
 * shows Agents meanwhile.
 */
export function useScreen(): ScreenId {
  const { path } = useRoute();
  const screen = screenFor(`#${path}`);
  useEffect(() => {
    if (screen === null) navigate('/agents', { replace: true });
  }, [screen]);
  return screen ?? 'agents';
}

const PLACEHOLDERS: Partial<Record<ScreenId, { title: string; blurb: string; nav?: ReactNode }>> = {
  evals: { title: 'Evaluations', blurb: 'Evaluators and annotation queues for scoring runs.', nav: <EvalsTabs /> },
};

/** `#/traces/:traceId`: the trace id comes from the hash; a new id remounts the screen. */
function TraceRoute() {
  const { path } = useRoute();
  const traceId = matchRoute(`#${path}`, ['/traces/:traceId'])?.params.traceId ?? '';
  return <TraceScreen key={traceId} traceId={traceId} />;
}

/** Every screen but Agents: the shell top bar over the screen's content. */
function ScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app app-screen">
      <h1 className="visually-hidden">Agent Forge</h1>
      <Topbar />
      <main className="screen-main">{children}</main>
    </div>
  );
}

/** The screens that render with no props, by id (Agents, the placeholders and Settings are handled in `Screens`). */
const SCREENS: Partial<Record<ScreenId, () => ReactNode>> = {
  traces: TracesScreen,
  trace: TraceRoute,
  monitoring: MonitoringScreen,
  scores: ScoresScreen,
  datasets: DatasetsScreen,
  playground: PlaygroundRoute,
  threads: ThreadsScreen,
  prompts: PromptsScreen,
  hub: HubScreen,
};

/** Renders the screen the hash route names; leaving Agents with unsaved changes asks first. */
export function Screens() {
  const screen = useLeaveAgentsGuard(useScreen());
  if (screen === 'agents') return <AgentsScreen />;

  const Screen = SCREENS[screen];
  const placeholder = PLACEHOLDERS[screen];
  let content: ReactNode;
  if (Screen) content = <Screen />;
  else if (placeholder) content = <Placeholder {...placeholder} />;
  else
    content = (
      <div className="screen-settings">
        <h2 className="visually-hidden">Settings</h2>
        <SettingsPanel />
      </div>
    );
  return <ScreenFrame>{content}</ScreenFrame>;
}
