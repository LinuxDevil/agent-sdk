import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObserveAgentRow, ObserveInsights, ObserveSessionRow } from '../src/observe/types';
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
  await expect(rows(page)).toHaveCount(2);
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

test('playground: loaded from a trace generation', async ({ page }) => {
  await open(page, '/playground?trace=e2e-trace&fromObs=e2e-obs');
  const typed = () => page.locator('main textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value).join('|'));
  await expect.poll(typed).toContain('Where is my order?');
  await shoot(page, 'playground');
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
  await edge.locator('.react-flow__edge-interaction').click({ force: true });
  await expect(edge).toHaveClass(/selected/);
  await page.locator('[data-node-type="tool"]').click();
  await expect(page.locator('.react-flow__node.selected [data-node-type="tool"]')).toBeVisible();
  await shoot(page, 'x-agents-selected');
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
    return { outline: s.outlineStyle, shadow: s.boxShadow, pulse: getComputedStyle(el, '::after').animationName };
  });
  expect(rings.outline).toBe('solid'); // breakpoint
  expect(rings.shadow).toMatch(/0px 0px 0px 3px/); // selected --ring
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
