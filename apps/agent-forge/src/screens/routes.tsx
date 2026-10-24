import { useEffect, type ReactNode } from 'react';
import { matchRoute, navigate } from '../router/router';
import { useRoute } from '../router/useRoute';
import { Topbar } from '../components/Topbar';
import { SettingsPanel } from '../components/SettingsPanel';
import { ObserveView, type ObserveTab } from '../observe/ObserveView';
import { AgentsScreen } from './agents/AgentsScreen';
import { TraceScreen } from './traces/TraceScreen';
import { MonitoringScreen } from './monitoring/MonitoringScreen';
import { useLeaveAgentsGuard } from './agents/useLeaveAgentsGuard';
import { Placeholder } from './Placeholder';

export type ScreenId =
  | 'agents'
  | 'playground'
  | 'traces'
  | 'trace'
  | 'threads'
  | 'monitoring'
  | 'scores'
  | 'evals'
  | 'prompts'
  | 'hub'
  | 'settings';

/** Hash route patterns, first match wins. Deep-link params are accepted now and read by the screens that land later. */
const ROUTES: { pattern: string; screen: ScreenId }[] = [
  { pattern: '/agents', screen: 'agents' },
  { pattern: '/agents/:id', screen: 'agents' },
  { pattern: '/playground', screen: 'playground' },
  { pattern: '/traces', screen: 'traces' },
  { pattern: '/traces/:traceId', screen: 'trace' },
  { pattern: '/threads', screen: 'threads' },
  { pattern: '/threads/:sessionId', screen: 'threads' },
  { pattern: '/monitoring', screen: 'monitoring' },
  { pattern: '/evals/scores', screen: 'scores' },
  { pattern: '/evals/:section', screen: 'evals' },
  { pattern: '/evals/:section/:id', screen: 'evals' },
  { pattern: '/prompts', screen: 'prompts' },
  { pattern: '/prompts/:name', screen: 'prompts' },
  { pattern: '/hub', screen: 'hub' },
  { pattern: '/hub/:namespace', screen: 'hub' },
  { pattern: '/settings', screen: 'settings' },
];

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

/** Until the Phase 3 screens land, Traces/Scores are the existing observe panels, one per route. */
const OBSERVE_TAB: Partial<Record<ScreenId, ObserveTab>> = { traces: 'traces', scores: 'scores' };
const TAB_PATH: Record<ObserveTab, string> = {
  traces: '/traces',
  scores: '/evals/scores',
};

const PLACEHOLDERS: Partial<Record<ScreenId, { title: string; blurb: string }>> = {
  playground: {
    title: 'Playground',
    blurb: 'Try a prompt against different models and settings side by side, without editing an agent.',
  },
  threads: { title: 'Threads', blurb: 'Multi-turn conversations grouped by session, with every run in each thread.' },
  evals: { title: 'Evaluations', blurb: 'Datasets, evaluators and annotation queues for scoring runs.' },
  prompts: { title: 'Prompts', blurb: 'Versioned prompts you can compare, pin and pull into your agents.' },
  hub: { title: 'Context Hub', blurb: 'The shared context namespaces your agents read from, browsable by namespace.' },
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

/** Renders the screen the hash route names; leaving Agents with unsaved changes asks first. */
export function Screens() {
  const screen = useLeaveAgentsGuard(useScreen());
  if (screen === 'agents') return <AgentsScreen />;

  const observeTab = OBSERVE_TAB[screen];
  const placeholder = PLACEHOLDERS[screen];
  let content: ReactNode;
  // Same element type at the same position for all three, so the drill-down filter survives a route change.
  if (screen === 'trace') content = <TraceRoute />;
  else if (screen === 'monitoring') content = <MonitoringScreen />;
  else if (observeTab) content = <ObserveView tab={observeTab} onTabChange={(tab) => navigate(TAB_PATH[tab])} />;
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
