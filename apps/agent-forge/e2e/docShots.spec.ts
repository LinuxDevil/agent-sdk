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
  { id: 'orders-bot', name: 'Orders bot', project: 'shop', status: 'healthy', age: 4_000, runs: 21, errorRate: 0.19, p95: 1_320 },
  { id: 'billing-bot', name: 'Billing bot', project: 'shop', status: 'healthy', age: 9_000, runs: 20, errorRate: 0.2, p95: 980 },
  { id: 'triage-bot', name: 'Triage bot', project: 'support', status: 'stale', age: 41_000, runs: 19, errorRate: 0.21, p95: 2_600 },
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
  dropped: 0,
  runs_today: a.runs,
  error_rate_today: a.errorRate,
}));

/** 18 hourly buckets per agent; a wave so the charts have shape. */
function series(): ObserveInsights['series'] {
  const rows: ObserveInsights['series'] = [];
  FLEET.forEach((a, n) => {
    for (let h = 17; h >= 0; h -= 1) {
      const bucket = Math.floor((NOW - h * HOUR) / HOUR) * HOUR;
      const runs = 2 + ((h + n * 3) % 4);
      const errors = h % 5 === n ? 1 : 0;
      const values: Record<string, number> = {
        runs,
        errors,
        cost_usd: runs * 0.0009,
        input_tokens: runs * 720,
        output_tokens: runs * 55,
        p95_latency_ms: a.p95 * (0.7 + ((h + n) % 4) * 0.12),
        error_rate: errors / runs,
      };
      for (const [metric, value] of Object.entries(values))
        rows.push({ bucket_start: bucket, granularity: 'hour', agent_id: a.id, metric, value });
    }
  });
  return rows;
}

const insights = (): ObserveInsights => ({
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
  series: series(),
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
    const p = new URL(route.request().url()).pathname.replace(/^\/observe/, '');
    if (p === '/api/v1/agents') return json(route, { agents });
    if (p === '/api/v1/insights') return json(route, insights());
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
  await page.getByRole('button', { name: '+ New agent' }).click();
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
  await expect(page.getByRole('region', { name: 'Fleet' }).locator('tbody tr')).toHaveCount(FLEET.length);
  await shoot(page, 'monitoring');
});

test('scores: an expanded eval', async ({ page }) => {
  await open(page, '/evals/scores?open=e2e-eval');
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
  await page.getByRole('button', { name: '+ New agent' }).click();
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
