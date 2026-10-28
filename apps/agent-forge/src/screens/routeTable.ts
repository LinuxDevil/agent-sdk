/** The Studio's screens, one id per top-level view. */
export type ScreenId =
  | 'agents'
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
  { pattern: '/agents', screen: 'agents', example: '/agents' },
  { pattern: '/agents/:id', screen: 'agents', example: '/agents/e2e-agent' },
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
  { pattern: '/settings', screen: 'settings', example: '/settings' },
];
