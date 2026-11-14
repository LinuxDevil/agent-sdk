/** The Studio's screens, one id per top-level view. 'agents' is the builder. */
export type ScreenId =
  | 'agents'
  | 'agentList'
  | 'codeAgent'
  | 'inbox'
  | 'agentDetail'
  | 'observedAgent'
  | 'templates'
  | 'playground'
  | 'traces'
  | 'trace'
  | 'threads'
  | 'monitoring'
  | 'scores'
  | 'datasets'
  | 'queues'
  | 'evaluators'
  | 'prompts'
  | 'hub'
  | 'workspaces'
  | 'workspace'
  | 'settings';

/** One hash route: its pattern, the screen it shows, and a concrete path that exercises it. */
export interface RouteEntry {
  readonly pattern: string;
  readonly screen: ScreenId;
  /** A real hash path (params filled in) for this pattern - the axe e2e scans every one. */
  readonly example: string;
}

/**
 * Hash route patterns, first match wins. Deep-link params are accepted now and read by the screens that land later.
 * Kept free of React so the Playwright specs can import it.
 */
export const ROUTES: readonly RouteEntry[] = [
  { pattern: '/agents', screen: 'agentList', example: '/agents' }, // every workspace (W06b fills it)
  // Pre-W04b links: '/agents/:id…' redirects (replace) into the launch workspace.
  { pattern: '/agents/:id', screen: 'agents', example: '/agents/e2e-agent' },
  { pattern: '/agents/:id/:tab', screen: 'agents', example: '/agents/e2e-agent/canvas' },
  // Keep '/w/:ws/agents/:id/canvas' above '/w/:ws/agents/:id/:tab': 'canvas' is a tab name too.
  { pattern: '/w/:ws/agents', screen: 'agentList', example: '/w/e2e-000000/agents' }, // one workspace's list
  { pattern: '/w/:ws/agents/:id', screen: 'agents', example: '/w/e2e-000000/agents/e2e-agent' }, // → canvas
  { pattern: '/w/:ws/agents/:id/canvas', screen: 'agents', example: '/w/e2e-000000/agents/e2e-agent/canvas' },
  { pattern: '/w/:ws/agents/:id/:tab', screen: 'agentDetail', example: '/w/e2e-000000/agents/e2e-agent/overview' },
  { pattern: '/observed/:agentId', screen: 'observedAgent', example: '/observed/e2e-observed' }, // read-only daemon agent (W07b)
  // Code agents (X06b/W08b): the path is one segment - the CodeAgentDir.path
  // encodeURIComponent'd ('agents%2Fsupport' decodes to 'agents/support').
  // The bare '/code-agents/:path' row is the pre-W08b link; it redirects.
  { pattern: '/code-agents/:path', screen: 'codeAgent', example: '/code-agents/agents%2Fsupport' },
  { pattern: '/w/:ws/code-agents/:path', screen: 'codeAgent', example: '/w/e2e-000000/code-agents/agents%2Fsupport' },
  { pattern: '/inbox', screen: 'inbox', example: '/inbox' },
  { pattern: '/templates', screen: 'templates', example: '/templates' },
  { pattern: '/playground', screen: 'playground', example: '/playground' },
  { pattern: '/traces', screen: 'traces', example: '/traces' },
  { pattern: '/traces/:traceId', screen: 'trace', example: '/traces/e2e-trace' },
  { pattern: '/threads', screen: 'threads', example: '/threads' },
  { pattern: '/threads/:sessionId', screen: 'threads', example: '/threads/e2e-session' },
  { pattern: '/monitoring', screen: 'monitoring', example: '/monitoring' },
  { pattern: '/evals/scores', screen: 'scores', example: '/evals/scores' },
  { pattern: '/evals/datasets', screen: 'datasets', example: '/evals/datasets' },
  { pattern: '/evals/datasets/:name', screen: 'datasets', example: '/evals/datasets/e2e-dataset' },
  { pattern: '/evals/queues', screen: 'queues', example: '/evals/queues' },
  { pattern: '/evals/queues/:id', screen: 'queues', example: '/evals/queues/e2e-queue' },
  { pattern: '/evals/evaluators', screen: 'evaluators', example: '/evals/evaluators' },
  { pattern: '/evals/evaluators/:id', screen: 'evaluators', example: '/evals/evaluators/e2e-evaluator' },
  { pattern: '/prompts', screen: 'prompts', example: '/prompts' },
  { pattern: '/prompts/:name', screen: 'prompts', example: '/prompts/e2e-prompt' },
  { pattern: '/hub', screen: 'hub', example: '/hub' },
  { pattern: '/hub/:namespace', screen: 'hub', example: '/hub/e2e-namespace' },
  { pattern: '/workspaces', screen: 'workspaces', example: '/workspaces' },
  { pattern: '/workspaces/:id', screen: 'workspace', example: '/workspaces/e2e-workspace' },
  { pattern: '/workspaces/:id/:section', screen: 'workspace', example: '/workspaces/e2e-workspace/pages' },
  { pattern: '/settings', screen: 'settings', example: '/settings' },
];
