import type { Page, Route } from '@playwright/test';
import type {
  ObserveAgentRow,
  ObserveDataset,
  ObserveExample,
  ObserveHubEntry,
  ObserveInsights,
  ObservePromptVersion,
  ObserveQueue,
  ObserveQueueItem,
  ObserveScoreRow,
  ObserveSessionRow,
  ObserveTraceDetail,
  ObserveTraceRow,
} from '../src/observe/types';

/**
 * A fake observe daemon behind the studio's `/observe` proxy, so the e2e specs
 * scan the screens' populated states rather than "daemon down". One agent, one
 * thread with one trace (an LLM call and a tool call), one prompt with two
 * versions, an eval's scores, a Context Hub namespace with a fleet and a
 * private entry, a dataset with two examples (one copied from the trace), and
 * an annotation queue whose next pending item is the trace.
 */
const NOW = Date.now();
const T0 = NOW - 60_000;

const trace: ObserveTraceRow = {
  trace_id: 'e2e-trace',
  name: 'support turn',
  agent_id: 'e2e-agent',
  session_id: 'e2e-session',
  start: T0,
  end: T0 + 1_800,
  status: 'ok',
  observations: 3,
  generations: 1,
  tools: 1,
  errors: 0,
  input_tokens: 120,
  output_tokens: 48,
  cost_usd: 0.0012,
  agent_name: 'Support bot',
  model: 'mock-echo',
  error_message: null,
  input_preview: 'Where is my order?',
  output_preview: 'It ships tomorrow.',
};

const failedTrace: ObserveTraceRow = {
  ...trace,
  trace_id: 'e2e-trace-failed',
  start: T0 - 120_000,
  end: T0 - 119_000,
  status: 'error',
  errors: 1,
  error_message: 'tool timed out',
  output_preview: null,
};

const session: ObserveSessionRow = {
  session_id: 'e2e-session',
  agent_id: 'e2e-agent',
  agent_name: 'Support bot',
  status: 'active',
  started_at: T0,
  ended_at: T0 + 1_800,
  traces: 1,
  input_tokens: 120,
  output_tokens: 48,
  cost_usd: 0.0012,
  last_input_preview: 'Where is my order?',
};

const observation = {
  trace_id: 'e2e-trace',
  session_id: 'e2e-session',
  agent_id: 'e2e-agent',
  status: 'ok',
  model: null,
  usage_input_tokens: null,
  usage_output_tokens: null,
  usage_cached_tokens: null,
  usage_reasoning_tokens: null,
  cost_usd: null,
  cost_partial: null,
  usage_estimated: null,
  truncated: false,
  attrs: null,
};

const score: ObserveScoreRow = {
  score_id: 'e2e-score',
  trace_id: 'e2e-trace',
  obs_id: null,
  name: 'e2e-eval',
  value: 1,
  source: 'eval',
  comment: null,
  agent_id: 'e2e-agent',
  created_at: T0 + 2_000,
};

const traceDetail: ObserveTraceDetail = {
  trace_id: 'e2e-trace',
  observations: [
    { ...observation, obs_id: 'e2e-root', parent_obs_id: null, kind: 'agent', name: 'support turn', start: T0, end: T0 + 1_800, input: 'Where is my order?', output: 'It ships tomorrow.' },
    {
      ...observation,
      obs_id: 'e2e-obs',
      parent_obs_id: 'e2e-root',
      kind: 'generation',
      name: 'llm',
      start: T0 + 100,
      end: T0 + 900,
      input: '[{"role":"user","content":"Where is my order?"}]',
      output: 'Let me look that up.',
      model: 'mock-echo',
      usage_input_tokens: 120,
      usage_output_tokens: 48,
      cost_usd: 0.0012,
    },
    { ...observation, obs_id: 'e2e-tool', parent_obs_id: 'e2e-root', kind: 'tool', name: 'lookup_order', start: T0 + 1_000, end: T0 + 1_700, input: '{"id":"42"}', output: '{"eta":"tomorrow"}' },
  ],
  scores: [score, { ...score, score_id: 'e2e-human', name: 'helpful', source: 'human', comment: 'clear answer', obs_id: null }],
};

const agent: ObserveAgentRow = {
  agent_id: 'e2e-agent',
  project: 'e2e',
  name: 'Support bot',
  version: '1.0.0',
  first_seen: T0 - 86_400_000,
  last_heartbeat: NOW - 5_000,
  status: 'online',
  heartbeat_age_ms: 5_000,
  heartbeat_interval_ms: 15_000,
  hostname: 'e2e-host',
  pid: 4242,
  dropped: 0,
  runs_today: 12,
  error_rate_today: 0.08,
};

const HOUR = 3_600_000;
const insights: ObserveInsights = {
  window: { since: NOW - 24 * HOUR, until: NOW },
  agents: [
    { agent_id: 'e2e-agent', project: 'e2e', name: 'Support bot', runs: 12, runs_per_day: 12, errors: 1, error_rate: 0.08, cost_usd: 0.0144, input_tokens: 1_440, output_tokens: 576, p50_latency_ms: 1_200, p95_latency_ms: 2_400 },
  ],
  series: ['runs', 'errors', 'cost_usd', 'input_tokens', 'output_tokens', 'p95_latency_ms', 'error_rate'].flatMap((metric, m) =>
    [0, 1, 2, 3].map((i) => ({ bucket_start: NOW - (4 - i) * HOUR, granularity: 'hour', agent_id: 'e2e-agent', metric, value: (i + 1) * (m + 1) })),
  ),
};

const promptVersion = (version: number, labels: string[], text: string): ObservePromptVersion => ({
  prompt_id: `e2e-prompt-${version}`,
  name: 'e2e-prompt',
  version,
  labels,
  variables: ['customer'],
  hash: `hash-${version}`,
  text,
  created_at: T0 - (3 - version) * HOUR,
  uses: version,
});
const promptVersions = [promptVersion(2, ['production'], 'Hello {{customer}}, how can I help today?'), promptVersion(1, [], 'Hello {{customer}}.')];

const hubEntry = (key: string, value: string, scope: ObserveHubEntry['scope'], ttl: number | null): ObserveHubEntry => ({
  entry_id: `e2e-hub-${key}`,
  namespace: 'e2e-namespace',
  agent_id: 'e2e-agent',
  key,
  value,
  scope,
  created_at: T0,
  ttl,
  expires_at: ttl === null ? null : T0 + ttl,
});
const hubEntries = [hubEntry('order-policy', '{"returns_days":30}', 'fleet', null), hubEntry('last-customer', 'cust-42', 'private', 24 * HOUR)];

const dataset: ObserveDataset = {
  dataset_id: 'e2e-dataset-id',
  name: 'e2e-dataset',
  description: 'Support cases the agent must get right',
  created_at: T0 - HOUR,
  example_count: 2,
};
const examples: ObserveExample[] = [
  {
    example_id: 'e2e-example-1',
    dataset_id: dataset.dataset_id,
    input: 'Where is my order?',
    expected: 'It ships tomorrow.',
    source_trace_id: 'e2e-trace',
    created_at: T0,
  },
  {
    example_id: 'e2e-example-2',
    dataset_id: dataset.dataset_id,
    input: [{ role: 'user', content: 'Can I return it?' }],
    expected: null,
    source_trace_id: null,
    created_at: T0 + 1_000,
  },
];

const queue: ObserveQueue = {
  queue_id: 'e2e-queue',
  name: 'support-review',
  rubric: [
    { name: 'helpfulness', description: 'Did the reply answer the question?', min: 0, max: 5 },
    { name: 'tone', min: 1, max: 3 },
  ],
  created_at: T0 - HOUR,
  counts: { pending: 1, done: 2, skipped: 0 },
};
const queueItem: ObserveQueueItem = {
  item_id: 'e2e-item',
  queue_id: queue.queue_id,
  trace_id: 'e2e-trace',
  status: 'pending',
  reviewer: null,
  created_at: T0,
  done_at: null,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Answer every `/observe/**` request from the fixtures above; anything unknown is the daemon's 404. */
export async function stubObserve(page: Page): Promise<void> {
  await page.route('**/observe/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/observe/, '');
    const q = url.searchParams;
    if (path === '/health') return json(route, { service: 'lousho-observe', ok: true, version: 'e2e' });
    if (path === '/__target') return json(route, { url: 'http://127.0.0.1:7777' });
    if (path === '/api/v1/traces') {
      const traces = q.get('status') === 'error' ? [failedTrace] : [trace, failedTrace];
      return json(route, { traces, total: traces.length, limit: 50, offset: 0 });
    }
    if (path === '/api/v1/traces/e2e-trace') return json(route, traceDetail);
    if (path === '/api/v1/sessions') return json(route, { sessions: [session], total: 1, limit: 50, offset: 0 });
    if (path === '/api/v1/sessions/e2e-session') return json(route, { session, traces: [trace] });
    if (path === '/api/v1/agents') return json(route, { agents: [agent] });
    if (path === '/api/v1/insights') return json(route, insights);
    if (path === '/api/v1/prompts') return json(route, { prompts: [{ ...promptVersions[0], versions: 2, uses: 3 }] });
    if (path === '/api/v1/prompts/e2e-prompt') return json(route, { name: 'e2e-prompt', versions: promptVersions });
    if (path === '/api/v1/hub' && route.request().method() === 'GET') {
      const ns = q.get('namespace');
      const scope = q.get('scope');
      return json(route, { entries: hubEntries.filter((e) => (!ns || e.namespace === ns) && (!scope || e.scope === scope)) });
    }
    if (path === '/api/v1/datasets' && route.request().method() === 'GET')
      return json(route, { datasets: [dataset], total: 1, limit: Number(q.get('limit') ?? 100), offset: 0 });
    if (path === '/api/v1/datasets/e2e-dataset')
      return json(route, { dataset, examples, total: examples.length, limit: Number(q.get('limit') ?? 1000), offset: 0 });
    if (path === '/api/v1/queues' && route.request().method() === 'GET')
      return json(route, { queues: [queue], total: 1, limit: Number(q.get('limit') ?? 100), offset: 0 });
    if (path === '/api/v1/queues/e2e-queue') return json(route, { queue });
    if (path === '/api/v1/queues/e2e-queue/next') return json(route, { item: queueItem });
    if (path === '/api/v1/scores') {
      if (q.get('aggregate') === 'eval')
        return json(route, { evals: [{ name: 'e2e-eval', count: 4, passed: 3, pass_rate: 0.75, avg_value: 0.75, last_ts: T0 + 2_000 }] });
      return json(route, { scores: [score, { ...score, score_id: 'e2e-score-2', value: 0, comment: 'wrong order id' }] });
    }
    return json(route, { error: 'not found' }, 404);
  });
}
