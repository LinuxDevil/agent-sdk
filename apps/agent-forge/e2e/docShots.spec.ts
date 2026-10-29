import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ObserveAgentRow,
  ObserveHubEntry,
  ObserveInsights,
  ObservePromptRow,
  ObservePromptVersion,
  ObserveSessionRow,
} from '../src/observe/types';
import { stubObserve } from './observeStub';
import { SEED_ERROR, SEED_NEWEST_FAILURE, seedObserve } from './fixtures/seedObserve';

/**
 * The screenshots in docs/agent-forge.md, taken from the built Studio against
 * the seeded fake daemon (`observeStub.ts` + `fixtures/seedObserve.ts`). Opt-in:
 *
 *   LOUSHO_DOC_SHOTS=1 npx playwright test -c apps/agent-forge/playwright.config.ts docShots
 *
 * writes `docs/images/studio-<screen>.png` at the repo root (1280x800, light).
 * Two optional overrides, for before/after reviews of a restyle:
 *
 *   LOUSHO_DOC_SHOTS_OUT=<dir>          write the PNGs there instead (absolute,
 *                                       or relative to the process cwd)
 *   LOUSHO_DOC_SHOTS_SCHEME=light|dark  the colour scheme to shoot (default light)
 *
 * The small fixtures below fill the screens the seed leaves thin: a fleet with
 * mixed health, a day of chart buckets for it, and a few threads.
 */
test.skip(!process.env.LOUSHO_DOC_SHOTS, 'set LOUSHO_DOC_SHOTS=1 to regenerate the docs screenshots');

/** `LOUSHO_DOC_SHOTS_SCHEME`, failing fast on anything but light or dark. */
function shotScheme(): 'light' | 'dark' {
  const raw = process.env.LOUSHO_DOC_SHOTS_SCHEME ?? 'light';
  if (raw === 'light' || raw === 'dark') return raw;
  throw new Error(`LOUSHO_DOC_SHOTS_SCHEME must be "light" or "dark", got "${raw}"`);
}

// Validated only when the shots run, so a stray value never breaks collection of a normal e2e run.
test.use({ viewport: { width: 1280, height: 800 }, colorScheme: process.env.LOUSHO_DOC_SHOTS ? shotScheme() : 'light' });

const APP = '/?token=e2e-studio-token';
const OUT = process.env.LOUSHO_DOC_SHOTS_OUT
  ? path.resolve(process.cwd(), process.env.LOUSHO_DOC_SHOTS_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/images');

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const FLEET = [
  { id: 'orders-bot', name: 'Orders bot', project: 'shop', status: 'healthy', age: 4_000, runs: 412, errorRate: 0.021, p95: 1_320, dropped: 0 },
  { id: 'billing-bot', name: 'Billing bot', project: 'shop', status: 'healthy', age: 9_000, runs: 268, errorRate: 0.034, p95: 980, dropped: 0 },
  { id: 'triage-bot', name: 'Triage bot', project: 'support', status: 'stale', age: 41_000, runs: 187, errorRate: 0.081, p95: 2_600, dropped: 3 },
  { id: 'refunds-bot', name: 'Refunds bot', project: 'shop', status: 'down', age: 5 * HOUR, runs: 46, errorRate: 0.043, p95: 1_750, dropped: 12 },
] as const;

const agents: ObserveAgentRow[] = FLEET.map((a) => ({
  agent_id: a.id,
  project: a.project,
  name: a.name,
  version: '1.0.0',
  first_seen: NOW - 48 * HOUR,
  last_heartbeat: NOW - a.age,
  status: a.status,
  heartbeat_age_ms: a.age,
  heartbeat_interval_ms: 15_000,
  hostname: 'seed-host',
  pid: 4242,
  dropped: a.dropped,
  runs_today: a.runs,
  error_rate_today: a.errorRate,
}));
/**
 * A registered agent with an 80-character name that has not run today (so it is in the
 * fleet table, where the name truncates with a tooltip, but in no chart).
 */
agents.push({
  ...agents[0]!,
  agent_id: 'onboarding-concierge',
  name: 'Customer onboarding concierge for enterprise accounts across EMEA and APAC (v2).',
  status: 'stale',
  last_heartbeat: NOW - 95_000,
  heartbeat_age_ms: 95_000,
  dropped: 0,
  runs_today: 0,
  error_rate_today: 0,
});

/**
 * Rollup rows per agent for every `granularity` bucket from `since` to now: gentle
 * waves so the charts have shape, and an agent that is down stops reporting
 * once its heartbeat stopped. The window before the shown one is in the rows
 * too (Monitoring asks for it), so the metric cards get a change.
 */
function series(since: number, granularity: 'hour' | 'day'): ObserveInsights['series'] {
  const step = granularity === 'day' ? 24 * HOUR : HOUR;
  const scale = step / HOUR;
  const rows: ObserveInsights['series'] = [];
  FLEET.forEach((a, n) => {
    for (let bucket = Math.floor(since / step) * step; bucket <= NOW - a.age; bucket += step) {
      const i = bucket / step;
      const runs = Math.round((a.runs / 24) * (1 + 0.35 * Math.sin(i / 3 + n * 1.7)) * scale);
      // A smooth rate (not whole errors per bucket), so the error-rate chart reads as trends, not spikes.
      const rate = a.errorRate * (1 + 0.5 * Math.sin(i / 2.5 + n * 2.1));
      const errors = runs * rate;
      const values: Record<string, number> = {
        runs,
        errors,
        cost_usd: runs * 0.0009 * (1 + n * 0.4),
        input_tokens: runs * 720,
        output_tokens: runs * 55,
        p95_latency_ms: a.p95 * (0.85 + 0.2 * Math.sin(i / 2 + n)),
        error_rate: runs ? rate : 0,
      };
      for (const [metric, value] of Object.entries(values))
        rows.push({ bucket_start: bucket, granularity, agent_id: a.id, metric, value });
    }
  });
  return rows;
}

/** The insights answer for `url`: the fleet's `days=1` call, or a window's rollups (`since` + `granularity`). */
const insights = (url: URL): ObserveInsights => ({
  window: { since: NOW - 24 * HOUR, until: NOW },
  agents: FLEET.map((a) => ({
    agent_id: a.id,
    project: a.project,
    name: a.name,
    runs: a.runs,
    runs_per_day: a.runs,
    errors: Math.round(a.runs * a.errorRate),
    error_rate: a.errorRate,
    cost_usd: a.runs * 0.0009,
    input_tokens: a.runs * 720,
    output_tokens: a.runs * 55,
    p50_latency_ms: a.p95 / 2,
    p95_latency_ms: a.p95,
  })),
  series: series(
    Number(url.searchParams.get('since') ?? NOW - 24 * HOUR),
    url.searchParams.get('granularity') === 'day' ? 'day' : 'hour',
  ),
});

const sessions: ObserveSessionRow[] = [
  ['seed-session-0', 0, 'active', 'Where is order ord_54?', 9],
  ['seed-session-1', 1, 'active', 'Why was I charged twice?', 6],
  ['seed-session-2', 2, 'ended', 'My parcel arrived damaged', 4],
  ['seed-session-3', 0, 'ended', 'Can I change the delivery address?', 3],
  ['seed-session-4', 1, 'interrupted', 'Refund the last invoice', 2],
].map(([id, agent, status, input, traces], i) => {
  const a = FLEET[agent as number];
  const started = NOW - (i + 1) * 2 * HOUR;
  return {
    session_id: id as string,
    agent_id: a.id,
    agent_name: a.name,
    status: status as string,
    started_at: started,
    ended_at: started + (traces as number) * 4 * MINUTE,
    traces: traces as number,
    input_tokens: (traces as number) * 720,
    output_tokens: (traces as number) * 55,
    cost_usd: (traces as number) * 0.0009,
    last_input_preview: input as string,
  };
});

/** A prompt with a real history for the x-prompt-* review shots (the stub's `e2e-prompt` has two one-line versions). */
const SUPPORT_TEXT = [
  'You are Mira, the support agent for {{shop}}.',
  'Answer in two or three short sentences.',
  'Always cite the order id when you talk about an order.',
  'Never promise a refund; open a refund request instead.',
  'If the customer is upset, apologise once and move on to the fix.',
];
const supportVersion = (version: number, labels: string[], lines: string[], hoursAgo: number, uses: number): ObservePromptVersion => ({
  prompt_id: `support-system-${version}`,
  name: 'support-system',
  version,
  labels,
  variables: ['shop'],
  hash: `9f${version}c4e1a${version}`,
  text: lines.join('\n'),
  created_at: NOW - hoursAgo * HOUR,
  uses,
});
const V4_TEXT = [...SUPPORT_TEXT.slice(0, 3), 'Never promise a refund; open a refund request with the order id instead.', SUPPORT_TEXT[4], 'Sign off with the ticket number.'];
const supportVersions: ObservePromptVersion[] = [
  supportVersion(4, ['staging'], V4_TEXT, 2, 3),
  supportVersion(3, ['production'], SUPPORT_TEXT, 26, 41),
  supportVersion(2, [], SUPPORT_TEXT.slice(0, 4), 74, 18),
  supportVersion(1, [], ['You are Mira, the support agent.', 'Answer briefly.'], 170, 6),
];
const promptRow = (v: ObservePromptVersion, patch: Partial<ObservePromptRow>): ObservePromptRow => ({ ...v, versions: v.version, ...patch });
const docPrompts: ObservePromptRow[] = [
  promptRow(supportVersions[0], { uses: 68 }),
  promptRow(supportVersions[1], { name: 'refund-triage', prompt_id: 'rt-2', version: 2, versions: 2, created_at: NOW - 5 * HOUR, uses: 12 }),
  promptRow(supportVersions[2], {
    name: 'order-lookup-tool',
    prompt_id: 'ol-7',
    version: 7,
    versions: 7,
    labels: ['production', 'staging'],
    created_at: NOW - 30 * HOUR,
    uses: 203,
  }),
  promptRow(supportVersions[3], { name: 'billing-faq', prompt_id: 'bf-1', created_at: NOW - 96 * HOUR, uses: 0 }),
];

/** A few namespaces of Context Hub entries for the x-hub review shots, written by the FLEET agents. */
function hub(
  namespace: string,
  key: string,
  value: unknown,
  scope: ObserveHubEntry['scope'],
  agent: string,
  minutesAgo: number,
  ttl: number | null = null,
): ObserveHubEntry {
  const created_at = NOW - minutesAgo * MINUTE;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { entry_id: `doc-${namespace}-${key}`, namespace, agent_id: agent, key, value: text, scope, created_at, ttl, expires_at: ttl === null ? null : created_at + ttl };
}
const hubEntries: ObserveHubEntry[] = [
  hub('orders', 'return-policy', { returns_days: 30, restocking_fee: 0, regions: ['EU', 'UK', 'US'] }, 'fleet', 'orders-bot', 12),
  hub('orders', 'carrier-status', { dhl: 'degraded', ups: 'ok', note: 'DHL delays in the EU since this morning' }, 'fleet', 'orders-bot', 4, 6 * HOUR),
  hub('orders', 'last-order-id', 'ord_54', 'private', 'billing-bot', 2, 24 * HOUR),
  hub('orders', 'escalation-contact', { team: 'logistics', channel: '#ops-orders', on_call: 'Sam' }, 'fleet', 'triage-bot', 95),
  hub('billing', 'refund-limits', { auto_approve_under: 25, currency: 'EUR' }, 'fleet', 'billing-bot', 40),
  hub('billing', 'invoice-template', 'Invoice {{number}} for {{customer}}: {{total}}, due {{due}}.', 'fleet', 'billing-bot', 300),
  hub('support-kb', 'greeting', 'Hi, I am Mira from the shop support team.', 'fleet', 'triage-bot', 600),
  hub('support-kb', 'known-issues', ['login loop on Safari 17', 'duplicate charge on retry'], 'fleet', 'triage-bot', 25, 2 * HOUR),
  hub('support-kb', 'tone', 'friendly, brief, no emoji', 'fleet', 'orders-bot', 1_400),
  hub('triage', 'queue-depth', { open: 14, waiting_on_customer: 5 }, 'private', 'billing-bot', 1, 10 * MINUTE),
];

/** The hub query as the daemon answers it: fleet entries plus the viewer's own private ones, by namespace and scope. */
function hubRows(q: URLSearchParams): ObserveHubEntry[] {
  const viewer = q.get('agent_id');
  const ns = q.get('namespace');
  const scope = q.get('scope');
  return hubEntries.filter((e) => (!ns || e.namespace === ns) && (!scope || e.scope === scope) && (e.scope === 'fleet' || e.agent_id === viewer));
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** The doc-only fixtures; registered after seedObserve, so they answer first. */
async function docFixtures(page: Page): Promise<void> {
  await page.route('**/observe/api/v1/**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/observe/, '');
    if (p === '/api/v1/agents') return json(route, { agents });
    if (p === '/api/v1/insights') return json(route, insights(url));
    if (p === '/api/v1/sessions') return json(route, { sessions, total: sessions.length, limit: 50, offset: 0 });
    if (p === '/api/v1/prompts') return json(route, { prompts: docPrompts });
    if (p === '/api/v1/prompts/support-system') return json(route, { name: 'support-system', versions: supportVersions });
    if (p === '/api/v1/hub') return json(route, { entries: hubRows(new URL(route.request().url()).searchParams) });
    return route.fallback();
  });
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await stubObserve(page);
  await seedObserve(page);
  await docFixtures(page);
});

async function open(page: Page, hash: string) {
  await page.goto(`${APP}#${hash}`);
  await expect(page.locator('.app')).toBeVisible();
}

async function shoot(page: Page, screen: string) {
  // Let toasts, focus rings and chart transitions settle.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `studio-${screen}.png`) });
}

/** Data rows only: a first load shows skeleton rows (`.skeleton-row`) until the rows arrive. */
const rows = (page: Page) => page.getByRole('main').locator('table.data-table tbody tr:not(.skeleton-row)');

test('agents: the builder with an agent', async ({ page }) => {
  await open(page, '/agents');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill('support-bot');
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-node-type="tool"]')).toBeVisible();
  await shoot(page, 'agents');
});

test('traces: the list', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await shoot(page, 'traces');
});

test('trace: a failed run with its error banner', async ({ page }) => {
  await open(page, `/traces/${SEED_NEWEST_FAILURE.trace_id}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(SEED_ERROR);
  await shoot(page, 'trace');
});

test('threads: the session list', async ({ page }) => {
  await open(page, '/threads');
  await expect(rows(page)).toHaveCount(sessions.length);
  await shoot(page, 'threads');
});

test('monitoring: fleet and charts', async ({ page }) => {
  await open(page, '/monitoring');
  await expect(page.locator('.mon-chart').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fleet' }).locator('tbody tr')).toHaveCount(agents.length);
  await shoot(page, 'monitoring');
});

// Review shots of the Monitoring redesign (x- prefix: never docs images).
const monitoringReady = async (page: Page) => {
  await expect(page.locator('.mon-chart svg.tsc-svg').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fleet' }).locator('tbody tr:not(.skeleton-row)')).toHaveCount(agents.length);
};

for (const win of ['1h', '7d'] as const) {
  test(`x-monitoring: the ${win} window`, async ({ page }) => {
    await open(page, `/monitoring?window=${win}`);
    await monitoringReady(page);
    await shoot(page, `x-monitoring-${win}`);
  });
}

test('x-monitoring: loading (the rollup query stalls)', async ({ page }) => {
  await page.route('**/observe/api/v1/insights?*', (route) =>
    new URL(route.request().url()).searchParams.has('granularity') ? new Promise<void>(() => undefined) : route.fallback(),
  );
  await open(page, '/monitoring');
  await expect(page.locator('.mon-charts[aria-busy="true"]')).toBeVisible();
  await shoot(page, 'x-monitoring-loading');
});

test('x-monitoring: no agents and an empty window', async ({ page }) => {
  await page.route('**/observe/api/v1/agents*', (route) => json(route, { agents: [] }));
  await page.route('**/observe/api/v1/insights?*', (route) =>
    json(route, { window: { since: NOW - 24 * HOUR, until: NOW }, agents: [], series: [] }),
  );
  await open(page, '/monitoring');
  await expect(page.locator('.mon-charts-empty')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fleet' }).getByText('No agents registered yet')).toBeVisible();
  await shoot(page, 'x-monitoring-empty');
});

test('x-monitoring: daemon down', async ({ page }) => {
  await page.route('**/observe/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' }));
  await open(page, '/monitoring');
  await expect(page.getByRole('main').getByText('lousho observe start')).toBeVisible();
  await shoot(page, 'x-monitoring-down');
});

for (const width of [860, 375]) {
  test(`x-monitoring: ${width}px wide, the whole screen`, async ({ page }) => {
    // The screen scrolls inside its own pane, so a tall viewport stands in for a full-page shot.
    await page.setViewportSize({ width, height: width < 600 ? 2400 : 1700 });
    await open(page, '/monitoring');
    await monitoringReady(page);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `studio-x-monitoring-${width}.png`) });
  });
}

test('scores: an expanded eval', async ({ page }) => {
  await open(page, '/evals/scores?open=e2e-eval');
  // The evals table must show its rows, not its first-load skeleton.
  await expect(rows(page).filter({ hasText: 'e2e-eval' }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Eval e2e-eval' })).toBeVisible();
  await shoot(page, 'scores');
});

test('datasets: one dataset with its examples', async ({ page }) => {
  await open(page, '/evals/datasets/e2e-dataset');
  await expect(rows(page)).toHaveCount(2);
  await shoot(page, 'datasets');
});

test('evaluators: the rule list', async ({ page }) => {
  await open(page, '/evals/evaluators');
  await expect(page.getByRole('main').locator('.ev-card')).toHaveCount(2);
  await expect(page.getByRole('switch', { name: 'answered enabled' })).toBeChecked();
  await shoot(page, 'evaluators');
});

test('annotation queue: reviewing an item', async ({ page }) => {
  await open(page, '/evals/queues/e2e-queue');
  await expect(page.locator('[data-review-trace="e2e-trace"]')).toBeVisible();
  await shoot(page, 'queue-review');
});

test('prompts: a prompt with labels and a diff', async ({ page }) => {
  await open(page, '/prompts/e2e-prompt?diff=1,2');
  await expect(page.getByRole('region', { name: 'Compare versions' })).toBeVisible();
  await shoot(page, 'prompts');
});

// Review-only shots of the Prompts and Context Hub screens (x- prefix: not in docs/agent-forge.md).
test('x-prompts-list: the prompt registry', async ({ page }) => {
  await open(page, '/prompts');
  await expect(rows(page)).toHaveCount(docPrompts.length);
  await shoot(page, 'x-prompts-list');
});

test('x-prompt-history: a prompt with its version history', async ({ page }) => {
  await open(page, '/prompts/support-system');
  await expect(page.getByRole('region', { name: 'Version history' })).toContainText('v1');
  await shoot(page, 'x-prompt-history');
});

test('x-prompt-diff-split: a side-by-side diff', async ({ page }) => {
  await open(page, '/prompts/support-system?diff=3,4');
  const compare = page.getByRole('region', { name: 'Compare versions' });
  await compare.getByRole('button', { name: 'Side by side' }).click();
  await expect(compare.locator('.prompt-diff-split')).toBeVisible();
  await shoot(page, 'x-prompt-diff-split');
});

test('x-hub: namespaces', async ({ page }) => {
  await open(page, '/hub?agent=billing-bot');
  await expect(page.getByRole('main').getByText('support-kb')).toBeVisible();
  await shoot(page, 'x-hub');
});

test('x-hub-entry: one entry open', async ({ page }) => {
  await open(page, '/hub/orders?agent=billing-bot');
  await page.getByRole('main').getByRole('button', { name: /carrier-status/ }).click();
  await expect(page.getByRole('region', { name: 'Entry carrier-status' })).toBeVisible();
  await shoot(page, 'x-hub-entry');
});

test('playground: loaded from a trace generation', async ({ page }) => {
  await open(page, '/playground?trace=e2e-trace&fromObs=e2e-obs');
  const typed = () => page.locator('main textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value).join('|'));
  await expect.poll(typed).toContain('Where is my order?');
  await shoot(page, 'playground');
});

/*
 * Review-only shots of the Playground (`x-` names: not in the docs set). A run
 * is staged by answering `POST /playground/run` with a canned SSE stream in the
 * wire shape sse.ts parses (`data: <PlaygroundEvent>` frames).
 */
const sseFrames = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

const PG_RUN_EVENTS = [
  { type: 'tool_call', id: 'call_1', name: 'order-status', args: { orderId: '4512', include: ['carrier', 'eta'] } },
  { type: 'delta', text: 'Your order #4512 shipped yesterday with UPS ' },
  { type: 'delta', text: 'and is due on Thursday. Track it at ups.com with the number 1Z 999 AA1 01 2345 6784.' },
  {
    type: 'done',
    finishReason: 'stop',
    text: 'Your order #4512 shipped yesterday with UPS and is due on Thursday. Track it at ups.com with the number 1Z 999 AA1 01 2345 6784.',
    traceId: 'e2e-trace',
    usage: { promptTokens: 412, completionTokens: 86, totalTokens: 498, inputTokens: 412, outputTokens: 86, estimated: false, costUsd: 0.00031 },
  },
];

async function stubPlaygroundRun(page: Page, events: unknown[], delayMs = 0) {
  await page.route('**/playground/run', async (route) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseFrames(events) });
  });
}

/** Fills the system and user messages (the system one has a `{company}` variable) and its value. */
async function fillPlayground(page: Page) {
  await open(page, '/playground');
  const boxes = page.getByRole('main').locator('textarea');
  await boxes.nth(0).fill('You are a support agent for {company}. Answer in two sentences and cite the order id.');
  await boxes.nth(1).fill('Where is my order #4512?');
  await page.getByRole('main').getByRole('textbox', { name: '{company}' }).fill('Acme Outfitters');
}

test('x-playground-idle: a fresh playground', async ({ page }) => {
  await open(page, '/playground');
  await expect(page.getByRole('main').locator('textarea').first()).toBeVisible();
  await shoot(page, 'x-playground-idle');
});

test('x-playground-run: a finished run with a tool call and metrics', async ({ page }) => {
  await stubPlaygroundRun(page, PG_RUN_EVENTS, 1200);
  await fillPlayground(page);
  await page.getByRole('main').getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /Open trace/ })).toBeVisible();
  const call = page.getByRole('main').locator('details.pg-tool-call > summary').first();
  if (await call.count()) await call.click();
  await shoot(page, 'x-playground-run');
});

test('x-playground-error: a failed run', async ({ page }) => {
  await stubPlaygroundRun(page, [
    { type: 'error', message: 'The openai provider has no API key. Add one under Settings, Providers.', code: 'LOUSHO_PROVIDER_MISSING_API_KEY' },
  ]);
  await fillPlayground(page);
  await page.getByRole('main').getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await shoot(page, 'x-playground-error');
});

test('x-playground-save: the save-prompt dialog open', async ({ page }) => {
  await fillPlayground(page);
  const trigger = page.getByRole('button', { name: 'Save prompt', exact: true });
  if (await trigger.count()) await trigger.click();
  await page.getByRole('main').getByRole('textbox', { name: 'Prompt name' }).fill('support-greeter');
  await shoot(page, 'x-playground-save');
});

test('x-playground narrow: 375 and 860 wide after a run', async ({ page }) => {
  await stubPlaygroundRun(page, PG_RUN_EVENTS);
  await fillPlayground(page);
  await page.getByRole('main').getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /Open trace/ })).toBeVisible();
  for (const [width, height, name] of [[375, 812, 'x-playground-narrow-375'], [860, 900, 'x-playground-860']] as const) {
    await page.setViewportSize({ width, height });
    await page.getByRole('main').evaluate((el) => el.scrollTo(0, 0));
    await shoot(page, name);
  }
  await page.getByRole('main').getByRole('link', { name: /Open trace/ }).scrollIntoViewIfNeeded();
  await shoot(page, 'x-playground-860-output');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('main').getByRole('button', { name: 'Run', exact: true }).scrollIntoViewIfNeeded();
  await shoot(page, 'x-playground-narrow-375-runbar');
});

test('command palette: open over Traces', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: 'Command' });
  await expect(input).toBeFocused();
  await input.fill('go');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, 'studio-command-palette.png') });
});

// Review-only shots of the shell (`x-` names: not in the docs set).
test('x: collapsed rail on Traces', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await page.waitForTimeout(250);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, 'x-rail-collapsed.png') });
});

test('x: 375 wide, Traces with the nav drawer closed and open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'x-narrow-traces.png') });
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'x-narrow-drawer-open.png') });
});

/*
 * Review-only shots of the Agents canvas (the `x-` prefix keeps them out of
 * the docs set): an empty canvas, a graph with a node selected, and a run in
 * progress. The run is staged by injecting a live status and spans into the
 * agent's stream socket, so nodes and edges hold their running state.
 */
async function newAgent(page: Page, name: string, template?: 'support-bot') {
  await open(page, '/agents');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(name);
  if (template) await page.locator('#new-agent-template').selectOption(template);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(name);
}

test('agents x: the empty canvas with its templates', async ({ page }) => {
  await newAgent(page, `empty-${Date.now()}`);
  const nodes = page.locator('.react-flow__node');
  while ((await nodes.count()) > 0) {
    const before = await nodes.count();
    await nodes.first().click();
    await page.keyboard.press('Delete');
    await expect(nodes).toHaveCount(before - 1);
  }
  await expect(page.getByRole('list', { name: 'Templates' })).toBeVisible();
  await shoot(page, 'x-agents-empty');
});

test('agents x: a graph with a node selected', async ({ page }) => {
  await newAgent(page, `selected-${Date.now()}`, 'support-bot');
  // The whole graph is in view on load, trigger included.
  const triggerInPane = () =>
    page.locator('[data-node-type="trigger"]').evaluate((el) => {
      const node = el.getBoundingClientRect();
      const pane = el.closest('.react-flow')!.getBoundingClientRect();
      return node.left >= pane.left && node.right <= pane.right && node.top >= pane.top && node.bottom <= pane.bottom;
    });
  await expect.poll(triggerInPane).toBe(true);
  // An edge can be selected (drawn in accent); selecting a node then moves the selection.
  const edge = page.locator('.react-flow__edge').nth(1);
  // Ports sit level with each card's header, so a pipeline edge is a flat line whose box has no height
  // (Playwright calls it off-screen): click the middle of its path instead.
  const mid = await edge.locator('.react-flow__edge-interaction').evaluate((el) => {
    const path = el as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: point.x * m.a + point.y * m.c + m.e, y: point.x * m.b + point.y * m.d + m.f };
  });
  await page.mouse.click(mid.x, mid.y);
  await expect(edge).toHaveClass(/selected/);
  await page.locator('[data-node-type="tool"]').click();
  await expect(page.locator('.react-flow__node.selected [data-node-type="tool"]')).toBeVisible();
  await shoot(page, 'x-agents-selected');
});

test('agents x: the default graph on load at 1280, 1440, 1920 and 860 wide', async ({ page }) => {
  const name = `fit-${Date.now()}`;
  await newAgent(page, name, 'support-bot');
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [860, 800]] as const) {
    // Reopened at each size, so every shot is the on-load fit (nothing selected, Inspector collapsed).
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator('.crumbs b')).toHaveText(name);
    await expect(page.locator('.canvas-wrap[data-fitting]')).toHaveCount(0);
    await shoot(page, `x-agents-fit-${width}`);
  }
});

test('agents x: a run in progress', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  const heardFromServer = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/stream/, (ws) => {
    const server = ws.connectToServer();
    // Forward the server's frames as usual, noting each socket's on-connect status.
    server.onMessage((message) => {
      ws.send(message);
      if (typeof message === 'string' && message.includes('"type":"status"')) heardFromServer.add(ws);
    });
    sockets.push(ws);
  });
  const name = `running-${Date.now()}`;
  await newAgent(page, name, 'support-bot');
  await expect(page.locator('[data-node-type="tool"]')).toBeVisible();
  // The builder and the rail each hold a socket for the open agent; both get the run.
  const own = () => sockets.filter((s) => s.url().includes(`/agents/${name}/stream`));
  await expect.poll(() => own().length).toBeGreaterThan(1);
  // The server's own on-connect status must land first, so ours is the last word.
  await expect.poll(() => own().every((ws) => heardFromServer.has(ws))).toBe(true);
  const start = Date.now() - 1_200;
  const send = (message: unknown) => own().forEach((ws) => ws.send(JSON.stringify(message)));
  send({ type: 'status', payload: { agentId: name, status: 'running' } });
  send({
    type: 'span',
    payload: { id: 'x-tool', name: 'execute_tool http', startTime: start, endTime: start + 400, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'http' } },
  });
  send({
    type: 'span',
    payload: { id: 'x-chat', name: 'chat mock-1', startTime: start, kind: 'client', attributes: { 'gen_ai.operation.name': 'chat' } },
  });
  await expect(page.locator('[data-node-type="llm"] .status-pill')).toHaveText('running');

  // A breakpoint on the running LLM node, which is also selected: every state ring stays visible.
  send({ type: 'debug', payload: { agentId: name, paused: false, messages: [], stepCount: 0, breakpoints: ['llm:before'] } });
  const llm = page.locator('[data-node-type="llm"]');
  await llm.click();
  await expect(llm).toHaveClass(/running/);
  await expect(llm).toHaveClass(/has-breakpoint/);
  await expect(llm).toHaveClass(/selected/);
  const rings = await llm.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, pulse: getComputedStyle(el, '::after').animationName };
  });
  expect(rings.outline).toBe('solid'); // breakpoint
  // Nothing is selected on load, so the click above just selected it: let the ring's transition land.
  await expect.poll(() => llm.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/0px 0px 0px 3px/); // selected --ring
  expect(rings.pulse).toBe('rf-node-running'); // running, on its own layer
  await shoot(page, 'x-agents-running');
});

// --- Kit states (x- shots: review-only, never used in the docs) -------------

test('x-kit: traces empty state', async ({ page }) => {
  await page.route('**/observe/api/v1/traces?**', (route) => json(route, { traces: [], total: 0, limit: 50, offset: 0 }));
  await open(page, '/traces');
  await expect(page.getByRole('main').locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-kit-empty-traces');
});

test('x-kit: traces table loading', async ({ page }) => {
  // Never answered: the table stays in its first-load state.
  await page.route('**/observe/api/v1/traces?**', () => undefined);
  await open(page, '/traces');
  await expect(page.getByRole('main').locator('table.data-table[aria-busy="true"]')).toBeVisible();
  await shoot(page, 'x-kit-loading-traces');
});

test('x-kit: filter bar with a facet and the custom range open', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Custom' }).click();
  await main.locator('.facet-btn').first().click();
  await expect(main.locator('.facet-pop')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'studio-x-kit-filters.png') });
});

// --- Overlay/message/chart kit states (x- shots, D3b) -------------------------

const CHAT_TRACE = 'doc-chat-trace';
const CHAT_GEN = `${CHAT_TRACE}-gen`;

/** A trace whose generation carries a full system/user/assistant(tool call)/tool transcript plus attributes. */
function chatTraceDetail() {
  const start = NOW - 10 * MINUTE;
  const base = {
    trace_id: CHAT_TRACE,
    session_id: 'seed-session-0',
    agent_id: 'orders-bot',
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
  const chat = [
    { role: 'system', content: 'You are the orders assistant. Answer briefly and cite the order status.' },
    { role: 'user', content: [{ type: 'text', text: 'Where is order ord_54? It was due yesterday.' }] },
    {
      role: 'assistant',
      content: 'Let me look that up.',
      tool_calls: [{ id: 'call_7f2', type: 'function', function: { name: 'lookup_order', arguments: '{"id":"ord_54","include":["shipping","events"]}' } }],
    },
    { role: 'tool', tool_call_id: 'call_7f2', content: '{"status":"in_transit","carrier":"PostNord","eta":"tomorrow"}' },
    { role: 'assistant', content: 'Order ord_54 is in transit with PostNord and should arrive tomorrow.' },
  ];
  return {
    trace_id: CHAT_TRACE,
    scores: [],
    observations: [
      { ...base, obs_id: `${CHAT_TRACE}-root`, parent_obs_id: null, kind: 'agent', name: 'orders-bot turn', start, end: start + 2_400, input: 'Where is order ord_54?', output: 'Order ord_54 is in transit.' },
      {
        ...base,
        obs_id: CHAT_GEN,
        parent_obs_id: `${CHAT_TRACE}-root`,
        kind: 'generation',
        name: 'llm',
        start: start + 20,
        end: start + 2_300,
        model: 'gpt-4o-mini',
        usage_input_tokens: 412,
        usage_output_tokens: 38,
        cost_usd: 0.00009,
        input: JSON.stringify(chat),
        output: JSON.stringify({ role: 'assistant', content: 'Order ord_54 is in transit with PostNord and should arrive tomorrow.' }),
        attrs: { 'gen_ai.system': 'openai', temperature: 0.2, max_tokens: 512, stream: false, tools: ['lookup_order', 'refund'], retry: null },
      },
    ],
  };
}

test('x-kit: trace step with a chat transcript and attributes', async ({ page }) => {
  await page.route(`**/observe/api/v1/traces/${CHAT_TRACE}`, (route) => json(route, chatTraceDetail()));
  await open(page, `/traces/${CHAT_TRACE}?obs=${CHAT_GEN}`);
  const main = page.getByRole('main');
  await expect(main.locator('.mv-bubble').first()).toBeVisible();
  await shoot(page, 'x-kit-trace-messages');
  // Scroll the inspector so the tool / assistant bubbles and the attributes tree are in view.
  await main.locator('.json-key', { hasText: 'temperature' }).first().scrollIntoViewIfNeeded();
  await shoot(page, 'x-kit-trace-attributes');
});

test('x-kit: chart tooltip, crosshair and legend with a series toggled off', async ({ page }) => {
  await open(page, '/monitoring');
  const runs = page.locator('[data-chart="Runs"]');
  await expect(runs.locator('svg.tsc-svg')).toBeVisible();
  // Legend chips are buttons once they toggle (D3b); before that they are plain list items.
  const billing = page.locator('[data-chart="Latency p95"] .tsc-legend button', { hasText: 'Billing bot' });
  if (await billing.count()) await billing.click();
  await runs.scrollIntoViewIfNeeded();
  const box = (await runs.locator('.tsc-plot').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2);
  await expect(runs.locator('.tsc-crosshair')).toHaveCount(1); // a zero-width line never counts as visible
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'studio-x-kit-chart-hover.png') });
});

test('x-kit: toasts (info and error)', async ({ page }) => {
  await page.route('**/observe/api/v1/evaluators/**', (route) =>
    route.request().method() === 'PUT' || route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'collector is read-only' }) })
      : route.fallback(),
  );
  await open(page, '/evals/evaluators/e2e-evaluator');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.toast').first()).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#/evals/evaluators';
  });
  const toggle = main.getByRole('switch', { name: 'answered enabled' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not disable' })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'studio-x-kit-toasts.png') });
});

test('x-kit: command palette sections, scrolled to the last group', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: 'Command' });
  await expect(input).toBeFocused();
  // ArrowUp from the first option wraps to the last one (Toggle theme), scrolling the list to the end.
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'studio-x-kit-palette-sections.png') });
});

/*
 * Review-only shots of the Agents rails, toolbar and run drawer: every drawer
 * tab after a real (mock-provider) chat that hit the `demo-approval` gate and
 * was approved, the approval card itself, the Nodes palette, and the builder
 * toolbar at 375 and 860 wide. A taller drawer gives the panels room.
 */
async function tallDrawer(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('forge.drawer.height', '400'));
}

test('agents x: the drawer on every tab after an approved chat', async ({ page }) => {
  test.setTimeout(90_000);
  await tallDrawer(page);
  await newAgent(page, `drawer-${Date.now()}`, 'support-bot');
  await page.locator('[data-node-type="tool"]').click();
  await page.locator('#node-tool-name').fill('demo-approval');
  const chatInput = page.locator('.chat-input');
  await chatInput.fill('Please call demo-approval to look something up for me.');
  await page.locator('.btn-send').click();
  const approval = page.locator('.chat-approval-card');
  await expect(approval).toBeVisible({ timeout: 15_000 });
  await shoot(page, 'x-agents-approval');

  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approval).toHaveCount(0, { timeout: 15_000 });
  await expect(chatInput).toBeEnabled();
  // From the top: the user's message, the tool call's mono block (with its result) and the reply.
  await expect(page.locator('.chat-msg.agent').last()).toBeVisible();
  await page.locator('.chat-messages').evaluate((el) => el.scrollTo({ top: 0 }));
  await shoot(page, 'x-agents-drawer-chat');

  for (const tab of ['Logs', 'Trace', 'Output', 'History', 'Settings'] as const) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    if (tab === 'Trace') {
      const history = page.getByRole('listbox', { name: 'Trace history' });
      await expect(history.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
      await history.getByRole('option').first().click();
      await expect(page.locator('.run-inspector')).toBeVisible();
    }
    if (tab === 'History') await expect(page.locator('.history-panel, .logs-empty').first()).toBeVisible();
    if (tab === 'Settings') await expect(page.getByLabel('Deploy adapter')).toBeVisible();
    await shoot(page, `x-agents-drawer-${tab.toLowerCase()}`);
  }
});

test('agents x: the Nodes palette in the left rail', async ({ page }) => {
  await newAgent(page, `nodes-${Date.now()}`, 'support-bot');
  await page.getByRole('tab', { name: 'Nodes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'LLM step' })).toBeVisible();
  await shoot(page, 'x-agents-rail-nodes');
});

test('agents x: the builder toolbar at 860 and 375 wide', async ({ page }) => {
  await newAgent(page, `toolbar-${Date.now()}`, 'support-bot');
  for (const width of [860, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible();
    await shoot(page, `x-agents-toolbar-${width}`);
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menu', { name: 'More actions' })).toBeVisible();
  await shoot(page, 'x-agents-toolbar-375-menu');
});

test("agents x: the routed settings screen shares the drawer's settings cards", async ({ page }) => {
  await open(page, '/settings');
  await expect(page.getByLabel('Deploy adapter')).toBeVisible();
  await shoot(page, 'x-agents-settings-screen');
  // Every card at once (the column scrolls inside .screen-main), then the narrow stack.
  await page.setViewportSize({ width: 1280, height: 1800 });
  await shoot(page, 'x-settings-screen-full');
  await page.setViewportSize({ width: 375, height: 800 });
  await shoot(page, 'x-settings-screen-375');
  await page.setViewportSize({ width: 375, height: 2600 });
  await shoot(page, 'x-settings-screen-375-full');
});

test('settings x: a stored key, an env key, a picked density and a focused theme segment', async ({ page }) => {
  // Answered in the browser: no real key is stored or sent anywhere.
  await page.route('**/settings/providers', (route) =>
    route.request().method() === 'GET'
      ? json(route, [
          { provider: 'openai', hasKey: true, masked: '<your-key>', envKey: false },
          { provider: 'anthropic', hasKey: false, masked: null, envKey: true },
        ])
      : route.fallback(),
  );
  await open(page, '/settings');
  await expect(page.getByText('From environment')).toBeVisible();
  await page.getByRole('group', { name: 'Table density' }).getByRole('button', { name: 'Comfortable' }).click();
  await expect(page.getByRole('button', { name: 'Reset to screen defaults' })).toBeVisible();
  // Programmatic focus after the click still counts as keyboard focus once Tab moves it.
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' })).toBeFocused();
  await shoot(page, 'x-settings-screen-states');
});

// --- Evaluations states (x- shots: review-only, never used in the docs) -----

const EVAL_RATES = [
  { name: 'e2e-eval', count: 4, passed: 3, pass_rate: 0.75, avg_value: 0.75, last_ts: NOW - 2 * MINUTE },
  { name: 'refund-policy', count: 48, passed: 46, pass_rate: 46 / 48, avg_value: 0.96, last_ts: NOW - 40 * MINUTE },
  { name: 'tone-and-empathy', count: 120, passed: 81, pass_rate: 81 / 120, avg_value: 0.71, last_ts: NOW - 3 * HOUR },
  { name: 'order-lookup-accuracy', count: 36, passed: 12, pass_rate: 12 / 36, avg_value: 0.41, last_ts: NOW - 26 * HOUR },
];

const DATASETS = [
  { name: 'e2e-dataset', description: 'Support cases the agent must get right', example_count: 2 },
  { name: 'refund-golden', description: 'Hand-picked refund conversations with the policy answer each one should cite, reviewed weekly by support leads', example_count: 148 },
  { name: 'escalations', description: null, example_count: 31 },
  { name: 'multilingual-smoke', description: 'Short greetings and order questions in eight languages', example_count: 1_204 },
  { name: 'regressions-2026-10', description: 'Every trace a human marked wrong in October', example_count: 57 },
].map((d, i) => ({ dataset_id: `ds-${i}`, created_at: NOW - (i + 1) * 30 * HOUR, ...d }));

/** The Scores aggregate answers with `evals` (and nothing else changes). */
async function evalRates(page: Page, evals: unknown[] | null) {
  await page.route('**/observe/api/v1/scores?**', (route) => {
    if (new URL(route.request().url()).searchParams.get('aggregate') !== 'eval') return route.fallback();
    // null: never answered, so the screen stays in its first-load state.
    return evals === null ? undefined : json(route, { evals });
  });
}

async function datasetList(page: Page, list: unknown[]) {
  await page.route('**/observe/api/v1/datasets?**', (route) =>
    route.request().method() === 'GET' ? json(route, { datasets: list, total: list.length, limit: 50, offset: 0 }) : route.fallback(),
  );
}

test('evals x: scores list, nothing expanded', async ({ page }) => {
  await evalRates(page, EVAL_RATES);
  await open(page, '/evals/scores');
  await expect(page.getByRole('main').getByText('order-lookup-accuracy').first()).toBeVisible();
  await shoot(page, 'x-evals-scores-list');
});

test('evals x: scores empty', async ({ page }) => {
  await evalRates(page, []);
  await open(page, '/evals/scores');
  await expect(page.getByRole('main').locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-evals-scores-empty');
});

test('evals x: scores loading', async ({ page }) => {
  await evalRates(page, null);
  await open(page, '/evals/scores');
  await expect(page.getByRole('main').locator('.skeleton').first()).toBeVisible();
  await shoot(page, 'x-evals-scores-loading');
});

test('evals x: datasets grid', async ({ page }) => {
  await datasetList(page, DATASETS);
  await open(page, '/evals/datasets');
  await expect(page.getByRole('main').getByText('multilingual-smoke').first()).toBeVisible();
  await shoot(page, 'x-evals-datasets-grid');
});

test('evals x: datasets empty', async ({ page }) => {
  await datasetList(page, []);
  await open(page, '/evals/datasets');
  await expect(page.getByRole('main').locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-evals-datasets-empty');
});

test('evals x: dataset detail with an example open', async ({ page }) => {
  await open(page, '/evals/datasets/e2e-dataset');
  await expect(rows(page)).toHaveCount(2);
  await rows(page).first().click();
  await expect(page.getByRole('main').getByRole('region', { name: 'Example e2e-example-1' })).toBeVisible();
  await shoot(page, 'x-evals-dataset-example');
});

test('evals x: new dataset form open', async ({ page }) => {
  await datasetList(page, DATASETS);
  await open(page, '/evals/datasets');
  await page.getByRole('button', { name: 'New dataset' }).click();
  await expect(page.getByRole('form', { name: 'New dataset' })).toBeVisible();
  await shoot(page, 'x-evals-datasets-new');
});

test('evals x: scores at 375 wide (header tabs all visible)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await evalRates(page, EVAL_RATES);
  await open(page, '/evals/scores');
  await expect(page.getByRole('navigation', { name: 'Evaluations' }).getByRole('link', { name: 'Annotation queues' })).toBeInViewport();
  await shoot(page, 'x-evals-scores-375');
});

// --- Traces list + trace detail review states (x- shots, P3) ----------------

const LONG_TRACE = 'doc-long-trace';

/**
 * A 25-step trace nested four levels deep: an agent root, three planner
 * turns, each with a sub-agent whose generations call tools (the last tool of
 * the second turn fails), plus a final answer generation.
 */
function longTraceDetail() {
  const start = NOW - 20 * MINUTE;
  const base = {
    trace_id: LONG_TRACE,
    session_id: 'seed-session-0',
    agent_id: 'orders-bot',
    status: 'ok',
    input: null,
    output: null,
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
  const root = `${LONG_TRACE}-root`;
  const observations: Record<string, unknown>[] = [
    { ...base, obs_id: root, parent_obs_id: null, kind: 'agent', name: 'orders-bot turn', start, end: start + 9_400, status: 'error', input: 'Refund every damaged item in my last three orders', attrs: { error: 'order service 503' } },
  ];
  for (let turn = 0; turn < 3; turn += 1) {
    const t0 = start + 40 + turn * 2_900;
    const span = `${LONG_TRACE}-span-${turn}`;
    const sub = `${LONG_TRACE}-sub-${turn}`;
    observations.push({ ...base, obs_id: span, parent_obs_id: root, kind: 'span', name: `plan step ${turn + 1}`, start: t0, end: t0 + 2_800 });
    observations.push({ ...base, obs_id: `${span}-gen`, parent_obs_id: span, kind: 'generation', name: 'llm', start: t0 + 10, end: t0 + 620, model: 'gpt-4o-mini', usage_input_tokens: 640 + turn * 80, usage_output_tokens: 42, cost_usd: 0.00012 });
    observations.push({ ...base, obs_id: sub, parent_obs_id: span, kind: 'agent', name: 'refunds sub-agent', start: t0 + 640, end: t0 + 2_780 });
    for (let call = 0; call < 2; call += 1) {
      const c0 = t0 + 660 + call * 1_050;
      const gen = `${sub}-gen-${call}`;
      const failed = turn === 1 && call === 1;
      observations.push({ ...base, obs_id: gen, parent_obs_id: sub, kind: 'generation', name: 'llm', start: c0, end: c0 + 480, model: 'gpt-4o-mini', usage_input_tokens: 820, usage_output_tokens: 31, cost_usd: 0.00014 });
      observations.push({
        ...base,
        obs_id: `${gen}-tool`,
        parent_obs_id: gen,
        kind: 'tool',
        name: call === 0 ? 'lookup_order' : 'issue_refund',
        start: c0 + 500,
        end: c0 + (failed ? 1_020 : 900),
        input: `{"order":"ord_${50 + turn}","item":${call}}`,
        ...(failed ? { status: 'error', attrs: { error: 'order service 503' } } : { output: '{"ok":true}' }),
      });
    }
  }
  observations.push({ ...base, obs_id: `${LONG_TRACE}-final`, parent_obs_id: root, kind: 'generation', name: 'llm', start: start + 8_800, end: start + 9_380, model: 'gpt-4o-mini', usage_input_tokens: 1_900, usage_output_tokens: 120, cost_usd: 0.0004, output: 'Two refunds were issued; the third failed.' });
  return { trace_id: LONG_TRACE, scores: [], observations };
}

const downObserve = (page: Page) =>
  page.route('**/observe/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' }));

test('x-traces: list with the daemon down', async ({ page }) => {
  await downObserve(page);
  await open(page, '/traces');
  await expect(page.getByRole('main').getByText('lousho observe start')).toBeVisible();
  await shoot(page, 'x-traces-down');
});

test('x-traces: detail with the errored step selected', async ({ page }) => {
  await open(page, `/traces/${SEED_NEWEST_FAILURE.trace_id}?obs=${SEED_NEWEST_FAILURE.trace_id}-gen-1`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(SEED_ERROR);
  await shoot(page, 'x-trace-error-selected');
});

test('x-traces: a long nested trace, tree and waterfall', async ({ page }) => {
  await page.route(`**/observe/api/v1/traces/${LONG_TRACE}`, (route) => json(route, longTraceDetail()));
  await open(page, `/traces/${LONG_TRACE}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('alert')).toBeVisible();
  await shoot(page, 'x-trace-long-tree');
  await main.getByRole('button', { name: 'Waterfall' }).click();
  await shoot(page, 'x-trace-long-waterfall');
});

test('x-traces: detail at 375 wide', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, `/traces/${SEED_NEWEST_FAILURE.trace_id}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(SEED_ERROR);
  await shoot(page, 'x-trace-narrow');
  await page.screenshot({ path: path.join(OUT, 'studio-x-trace-narrow-full.png'), fullPage: true });
});

test("x-traces: the Agents drawer's Trace tab (narrow host)", async ({ page }) => {
  await newAgent(page, `drawer-trace-${Date.now()}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.topbar [role="status"]')).toContainText('done', { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  const history = page.getByRole('listbox', { name: 'Trace history' });
  await expect(history.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
  await history.getByRole('option').first().click();
  await expect(page.locator('.run-inspector')).toBeVisible();
  await shoot(page, 'x-drawer-trace');
});

// --- Threads list + thread detail review states (x- shots, P4) --------------

const LONG_THREAD = 'doc-long-thread';

/** A long assistant reply: `lines` numbered steps, well past the 12-line clamp. */
const longReply = (topic: string, lines: number) =>
  [`Here is what I found (${topic}):`, '', ...Array.from({ length: lines }, (_, i) => `${i + 1}. Order ord_${50 + i}: looked up, carrier status read and the ${topic} rules applied.`), '', 'Anything else I can help with?'].join('\n');

/** Three turns: two long replies (one stays collapsed, one is expanded in the shot) and a failed one. */
const THREAD_TURNS = [
  { ask: 'Where are my last three orders?', reply: longReply('delivery', 16), error: null },
  { ask: 'And which of them can still be refunded? Please list every item, the refund window and what I need to send back.', reply: longReply('refunds', 18), error: null },
  { ask: 'Refund the damaged blender from ord_52.', reply: null, error: 'Tool issue_refund failed: order service 503 (retry after 30s)' },
] as const;

function longThread() {
  const start = NOW - 50 * MINUTE;
  const session: ObserveSessionRow = {
    session_id: LONG_THREAD,
    agent_id: 'orders-bot',
    agent_name: 'Orders bot',
    status: 'interrupted',
    started_at: start,
    ended_at: start + 14 * MINUTE,
    traces: THREAD_TURNS.length,
    input_tokens: 5_840,
    output_tokens: 1_312,
    cost_usd: 0.0061,
    last_input_preview: THREAD_TURNS[2].ask,
  };
  const traces = THREAD_TURNS.map((turn, i) => {
    const t0 = start + i * 6 * MINUTE;
    return {
      trace_id: `${LONG_THREAD}-turn-${i}`,
      name: 'orders-bot turn',
      agent_id: 'orders-bot',
      agent_name: 'Orders bot',
      session_id: LONG_THREAD,
      start: t0,
      end: t0 + 2_400 + i * 1_700,
      status: turn.error ? 'error' : 'ok',
      observations: 6,
      generations: 2,
      tools: 2,
      errors: turn.error ? 1 : 0,
      input_tokens: 1_600 + i * 420,
      output_tokens: turn.error ? 40 : 520 + i * 90,
      cost_usd: 0.0018 + i * 0.0003,
      model: 'gpt-4o-mini',
      error_message: turn.error,
      input_preview: turn.ask.slice(0, 200),
      output_preview: turn.reply?.slice(0, 200) ?? null,
    };
  });
  return { session, traces };
}

function longThreadDetail(i: number) {
  const { traces } = longThread();
  const t = traces[i];
  const turn = THREAD_TURNS[i];
  const input = JSON.stringify([
    { role: 'system', content: 'You are the orders bot. Look orders up before answering.' },
    { role: 'user', content: turn.ask },
  ]);
  const root = {
    obs_id: `${t.trace_id}-root`, trace_id: t.trace_id, session_id: LONG_THREAD, agent_id: 'orders-bot', parent_obs_id: null,
    kind: 'agent', name: t.name, start: t.start, end: t.end, status: t.status, input, output: turn.reply,
    model: null, usage_input_tokens: null, usage_output_tokens: null, usage_cached_tokens: null, usage_reasoning_tokens: null,
    cost_usd: null, cost_partial: null, usage_estimated: null, truncated: false, attrs: turn.error ? { error: turn.error } : null,
  };
  return { trace_id: t.trace_id, scores: [], observations: [root] };
}

async function longThreadRoutes(page: Page) {
  await page.route(`**/observe/api/v1/sessions/${LONG_THREAD}`, (route) => json(route, longThread()));
  await page.route(`**/observe/api/v1/traces/${LONG_THREAD}-turn-*`, (route) => {
    const i = Number(/-turn-(\d+)$/.exec(new URL(route.request().url()).pathname)?.[1]);
    return json(route, longThreadDetail(i));
  });
}

const turnsOf = (page: Page) => page.getByRole('main').locator('.thread-turn');

test('x-threads: list loading', async ({ page }) => {
  // Never answered: the table stays in its first-load state.
  await page.route('**/observe/api/v1/sessions?**', () => undefined);
  await open(page, '/threads');
  await expect(page.getByRole('main').locator('table.data-table[aria-busy="true"]')).toBeVisible();
  await shoot(page, 'x-threads-loading');
});

test('x-threads: list empty', async ({ page }) => {
  await page.route('**/observe/api/v1/sessions?**', (route) => json(route, { sessions: [], total: 0, limit: 50, offset: 0 }));
  await open(page, '/threads');
  await expect(page.getByRole('main').locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-threads-empty');
});

test('x-threads: detail loading', async ({ page }) => {
  await page.route(`**/observe/api/v1/sessions/${LONG_THREAD}`, () => undefined);
  await open(page, `/threads/${LONG_THREAD}`);
  await page.waitForTimeout(400);
  await shoot(page, 'x-thread-loading');
});

test('x-threads: detail with long turns (collapsed, expanded, errored)', async ({ page }) => {
  await longThreadRoutes(page);
  await open(page, `/threads/${LONG_THREAD}`);
  await expect(turnsOf(page)).toHaveCount(THREAD_TURNS.length);
  await expect(turnsOf(page).first()).toContainText('Anything else I can help with?');
  await shoot(page, 'x-thread-long');
  const second = turnsOf(page).nth(1);
  const more = second.getByRole('button', { name: 'Show more' });
  if ((await more.count()) > 0) await more.last().click();
  await second.scrollIntoViewIfNeeded();
  await shoot(page, 'x-thread-expanded');
  await turnsOf(page).nth(2).scrollIntoViewIfNeeded();
  await shoot(page, 'x-thread-error');
  await page.screenshot({ path: path.join(OUT, 'studio-x-thread-long-full.png'), fullPage: true });
});

test('x-threads: detail at 375 wide', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await longThreadRoutes(page);
  await open(page, `/threads/${LONG_THREAD}`);
  await expect(turnsOf(page)).toHaveCount(THREAD_TURNS.length);
  await shoot(page, 'x-thread-narrow');
  await page.screenshot({ path: path.join(OUT, 'studio-x-thread-narrow-full.png'), fullPage: true });
});

// --- Evaluators and annotation queues (x- shots, P7) -------------------------

const RULES = [
  { rule_id: 'e2e-evaluator', name: 'answered', enabled: true, filter: { agent_id: 'e2e-agent', status: 'ok' }, sample_rate: 1, kind: 'code', config: { source: '(trace) => (trace.output ? 1 : 0)' } },
  { rule_id: 'e2e-judge', name: 'polite', enabled: false, filter: {}, sample_rate: 0.5, kind: 'judge', config: { model: 'openai/gpt-4o-mini', rubric: 'Is the reply polite? Score 1 when it is courteous and calm, 0 otherwise.' } },
  { rule_id: 'x-refund', name: 'refund-policy-cited', enabled: true, filter: { name_contains: 'refund' }, sample_rate: 0.25, kind: 'judge', config: { model: 'anthropic/claude-haiku', rubric: 'Does the reply cite the refund policy?' } },
  { rule_id: 'x-tools', name: 'tool-calls-under-budget-for-every-order-lookup-in-the-support-fleet', enabled: true, filter: { status: 'error' }, sample_rate: 0.1, kind: 'code', config: { source: '(trace) => trace.observations.length < 12 ? 1 : 0' } },
].map((r) => ({ created_at: NOW - 30 * HOUR, updated_at: NOW - 30 * HOUR, ...r }));

const QUEUES = [
  { queue_id: 'e2e-queue', name: 'support-review', rubric: [{ name: 'helpfulness', min: 0, max: 5 }, { name: 'tone', min: 1, max: 3 }], counts: { pending: 1, done: 2, skipped: 0 } },
  { queue_id: 'x-refunds', name: 'refund-escalations', rubric: [{ name: 'correct', min: 0, max: 1 }, { name: 'policy cited', min: 0, max: 1 }, { name: 'empathy', min: 1, max: 5 }], counts: { pending: 14, done: 41, skipped: 3 } },
  { queue_id: 'x-new', name: 'multilingual-greetings-weekly-spot-check', rubric: [{ name: 'fluency' }], counts: { pending: 25, done: 0, skipped: 0 } },
  { queue_id: 'x-done', name: 'october-regressions', rubric: [{ name: 'fixed', min: 0, max: 1 }], counts: { pending: 0, done: 57, skipped: 4 } },
].map((q, i) => ({ created_at: NOW - (i + 1) * 26 * HOUR, ...q }));

async function evaluatorList(page: Page, list: unknown[]) {
  await page.route('**/observe/api/v1/evaluators?**', (route) =>
    route.request().method() === 'GET' ? json(route, { evaluators: list, total: list.length, limit: 50, offset: 0 }) : route.fallback(),
  );
}

async function queueList(page: Page, list: unknown[]) {
  await page.route('**/observe/api/v1/queues?**', (route) =>
    route.request().method() === 'GET' ? json(route, { queues: list, total: list.length, limit: 50, offset: 0 }) : route.fallback(),
  );
}

const main = (page: Page) => page.getByRole('main');

test('evals x: evaluators grid', async ({ page }) => {
  await evaluatorList(page, RULES);
  await open(page, '/evals/evaluators');
  await expect(main(page).getByRole('switch', { name: 'polite enabled' })).toBeVisible();
  await shoot(page, 'x-evals-evaluators-grid');
});

test('evals x: evaluators empty', async ({ page }) => {
  await evaluatorList(page, []);
  await open(page, '/evals/evaluators');
  await expect(main(page).locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-evals-evaluators-empty');
});

test('evals x: new evaluator form (code rule)', async ({ page }) => {
  await open(page, '/evals/evaluators');
  await page.getByRole('button', { name: 'New evaluator' }).first().click();
  await expect(page.getByRole('form', { name: 'New evaluator' })).toBeVisible();
  await shoot(page, 'x-evals-evaluator-new-code');
});

test('evals x: new evaluator form (LLM judge)', async ({ page }) => {
  // A stored provider key enables the judge option (no real key is sent anywhere: the route answers in the browser).
  await page.route('**/settings/providers', (route) =>
    route.request().method() === 'GET'
      ? json(route, [
          { provider: 'openai', hasKey: true, masked: '<your-key>', envKey: false },
          { provider: 'anthropic', hasKey: false, masked: null, envKey: false },
        ])
      : route.fallback(),
  );
  await open(page, '/evals/evaluators');
  await page.getByRole('button', { name: 'New evaluator' }).first().click();
  const form = page.getByRole('form', { name: 'New evaluator' });
  await form.getByRole('radio', { name: 'LLM judge' }).check();
  await form.locator('[name="evaluator-name"]').fill('helpful');
  await form.locator('[name="evaluator-model"]').fill('gpt-4o-mini');
  await form.locator('[name="evaluator-rubric"]').fill('Score 1 when the reply answers the customer question with the order status, 0 otherwise.');
  await shoot(page, 'x-evals-evaluator-new-judge');
});

test('evals x: evaluator edit view (code rule)', async ({ page }) => {
  await open(page, '/evals/evaluators/e2e-evaluator');
  await expect(page.getByRole('form', { name: 'Edit evaluator' })).toBeVisible();
  await shoot(page, 'x-evals-evaluator-edit-code');
});

test('evals x: evaluator edit view (LLM judge)', async ({ page }) => {
  await page.route('**/observe/api/v1/evaluators/e2e-judge', (route) =>
    route.request().method() === 'GET' ? json(route, { evaluator: RULES[1] }) : route.fallback(),
  );
  await open(page, '/evals/evaluators/e2e-judge');
  await expect(page.locator('[name="evaluator-rubric"]')).toBeVisible();
  await shoot(page, 'x-evals-evaluator-edit-judge');
});

test('evals x: queues list', async ({ page }) => {
  await queueList(page, QUEUES);
  await open(page, '/evals/queues');
  await expect(main(page).getByText('refund-escalations').first()).toBeVisible();
  await shoot(page, 'x-evals-queues-list');
});

test('evals x: queues empty', async ({ page }) => {
  await queueList(page, []);
  await open(page, '/evals/queues');
  await expect(main(page).locator('.empty-state')).toBeVisible();
  await shoot(page, 'x-evals-queues-empty');
});

test('evals x: new queue form with rubric rows', async ({ page }) => {
  await queueList(page, QUEUES);
  await open(page, '/evals/queues');
  const toggle = page.getByRole('button', { name: 'New queue' });
  if (await toggle.count()) await toggle.first().click();
  const form = page.getByRole('form', { name: 'New annotation queue' });
  await form.locator('[name="queue-name"]').fill('billing-review');
  await form.locator('[name="rubric-name-0"]').fill('correct');
  await form.locator('[name="rubric-min-0"]').fill('0');
  await form.locator('[name="rubric-max-0"]').fill('1');
  await form.getByRole('button', { name: /Add rubric (row|entry)/ }).click();
  await form.locator('[name="rubric-name-1"]').fill('empathy');
  await form.locator('[name="rubric-description-1"]').fill('Did the reply acknowledge the problem?');
  await form.locator('[name="rubric-min-1"]').fill('1');
  await form.locator('[name="rubric-max-1"]').fill('5');
  await shoot(page, 'x-evals-queues-new');
});

test('evals x: queue review at 375 wide', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, '/evals/queues/e2e-queue');
  await expect(page.locator('[data-review-trace="e2e-trace"]')).toBeVisible();
  await shoot(page, 'x-evals-queue-review-375');
  await page.getByRole('form', { name: 'Scores' }).getByRole('button', { name: 'Skip' }).scrollIntoViewIfNeeded();
  await shoot(page, 'x-evals-queue-review-375-rubric');
});

test('evals x: queue review, queue is empty', async ({ page }) => {
  await page.route('**/observe/api/v1/queues/e2e-queue/next', (route) => route.fulfill({ status: 204 }));
  await page.route('**/observe/api/v1/queues/e2e-queue', (route) =>
    json(route, { queue: { ...QUEUES[0], counts: { pending: 0, done: 2, skipped: 1 } } }),
  );
  await open(page, '/evals/queues/e2e-queue');
  await expect(main(page).getByText('Queue is empty')).toBeVisible();
  await shoot(page, 'x-evals-queue-empty');
});

test('x-traces: a tool step selected, tree and waterfall', async ({ page }) => {
  await page.route(`**/observe/api/v1/traces/${LONG_TRACE}`, (route) => json(route, longTraceDetail()));
  await open(page, `/traces/${LONG_TRACE}?obs=${LONG_TRACE}-sub-0-gen-0-tool`);
  const main = page.getByRole('main');
  await expect(main.locator('.run-inspector')).toHaveAttribute('data-obs-id', `${LONG_TRACE}-sub-0-gen-0-tool`);
  await shoot(page, 'x-trace-tool-selected');
  await main.getByRole('button', { name: 'Waterfall' }).click();
  await shoot(page, 'x-trace-tool-selected-waterfall');
});

test('x-shell: the ? shortcut sheet, at 1280 and 375 wide', async ({ page }) => {
  await open(page, '/traces');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await shoot(page, 'x-shortcut-sheet');
  await page.setViewportSize({ width: 375, height: 800 });
  await shoot(page, 'x-shortcut-sheet-375');
});

test('x-shell: the error boundary after a render crash, at 1280 and 375 wide', async ({ page }) => {
  // A session id the thread list renders as text, sent as an object: React cannot render it, and the app-level boundary catches it.
  await page.route(/\/observe\/api\/v1\/sessions(\?|$)/, (route) =>
    json(route, { sessions: [{ ...sessions[0], session_id: { broken: true } }], total: 1, limit: 50, offset: 0 }),
  );
  await page.goto(`${APP}#/threads`);
  await expect(page.getByRole('alert').getByText('Something went wrong')).toBeVisible();
  await shoot(page, 'x-error-boundary');
  await page.setViewportSize({ width: 375, height: 800 });
  await shoot(page, 'x-error-boundary-375');
});

test('x-traces: a running trace in the waterfall (motion and reduced motion)', async ({ page }) => {
  // The root, the last plan step, its sub-agent, one tool call and the final generation still open (end: null).
  const detail = longTraceDetail();
  const openIds = new Set([`${LONG_TRACE}-span-2`, `${LONG_TRACE}-sub-2`, `${LONG_TRACE}-sub-2-gen-1-tool`, `${LONG_TRACE}-final`]);
  // Shifted so the run started ~11s ago (the fixture's is 20 minutes back): the open bars run to "now" at a readable scale.
  const shift = 20 * MINUTE - 11_000;
  const observations = detail.observations.map((o) => {
    const moved = { ...o, start: Number(o.start) + shift, end: o.end === null ? null : Number(o.end) + shift };
    return o.parent_obs_id === null || openIds.has(String(o.obs_id)) ? { ...moved, end: null, status: 'ok', attrs: null } : moved;
  });
  await page.route(`**/observe/api/v1/traces/${LONG_TRACE}`, (route) => json(route, { ...detail, observations }));
  await open(page, `/traces/${LONG_TRACE}`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Waterfall' }).click();
  await expect(main.locator('.run-wf-bar.running').first()).toBeVisible();
  await main.locator('.run-wf-bar.running').last().scrollIntoViewIfNeeded();
  await shoot(page, 'x-trace-running-waterfall');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await shoot(page, 'x-trace-running-waterfall-reduced');
});
