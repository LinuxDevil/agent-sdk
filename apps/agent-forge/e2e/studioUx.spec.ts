import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * Status, copy and naming match the docs - a finished run says
 * `done`, Run's prompt is labelled "Run input" in Chat, a new agent is named
 * what you typed, the open agent can be renamed and deleted, and a dropped
 * server connection is announced.
 */
const TOKEN = 'e2e-studio-token';
const API = { headers: { 'x-lousho-studio-token': TOKEN } };

async function createAgent(page: Page, id: string) {
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(id);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(id);
}

async function agentIds(page: Page): Promise<string[]> {
  const res = await page.request.get('/agents', API);
  return ((await res.json()) as { id: string }[]).map((a) => a.id);
}

test('a new agent is named what you typed; a finished run says done and labels its input', async ({ page }) => {
  const id = `ux-named-${Date.now()}`;
  await page.goto(`/?token=${TOKEN}`);
  await createAgent(page, id);

  const saved = await page.request.get(`/agents/${id}`, API);
  expect(((await saved.json()) as { name: string }).name).toBe(id);

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.topbar [role="status"]')).toContainText('done', { timeout: 15_000 });
  await expect(page.locator('.topbar [role="status"]')).not.toContainText('stopped');
  // The finished run links to its trace (builder runs report to the observe daemon).
  await expect(page.getByRole('link', { name: 'Open trace' })).toHaveAttribute('href', /^#\/traces\/[^/]+$/);

  const runBubble = page.locator('.chat-msg.run-input');
  await expect(runBubble).toBeVisible();
  await expect(runBubble).toContainText('Run input');
  await expect(page.locator('.chat-msg.user:not(.run-input)')).toHaveCount(0);
});

test("the drawer's Trace tab shows a finished run in the shared trace viewer", async ({ page }) => {
  const id = `ux-trace-${Date.now()}`;
  await page.goto(`/?token=${TOKEN}`);
  await createAgent(page, id);

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.topbar [role="status"]')).toContainText('done', { timeout: 15_000 });

  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  // The saved run is listed; choosing it opens its steps in the tree + inspector.
  const history = page.getByRole('listbox', { name: 'Trace history' });
  await expect(history.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
  await history.getByRole('option').first().click();
  const tree = page.getByRole('group', { name: 'Run tree' });
  await expect(tree.locator('.run-tree-row').first()).toBeVisible();
  await expect(tree.locator('.run-kind[data-kind="generation"]').first()).toBeVisible();
  await expect(page.locator('.run-inspector')).toBeVisible();

  await page.getByRole('group', { name: 'Trace layout' }).getByRole('button', { name: 'Waterfall' }).click();
  await expect(page.getByRole('group', { name: 'Waterfall' }).locator('.run-wf-row').first()).toBeVisible();
});

test('the open agent can be renamed and deleted from the rail', async ({ page }) => {
  const id = `ux-rename-${Date.now()}`;
  const renamed = `${id}-b`;
  await page.goto(`/?token=${TOKEN}`);
  await createAgent(page, id);

  const card = page.locator('.agent-card.selected');
  await card.getByRole('button', { name: `Rename ${id}`, exact: true }).click();
  const input = page.getByRole('textbox', { name: `New name for ${id}` });
  await input.fill(renamed);
  await input.press('Enter');
  await expect(page.locator('.crumbs b')).toHaveText(renamed);
  await expect.poll(() => agentIds(page)).toContain(renamed);
  expect(await agentIds(page)).not.toContain(id);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('.agent-card.selected').getByRole('button', { name: `Delete ${renamed}` }).click();
  await expect.poll(() => agentIds(page)).not.toContain(renamed);
  await expect(page.locator('.agent-card', { hasText: renamed })).toHaveCount(0);
});

test('a dropped connection to the studio server shows a banner until it reconnects', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  let dropping = false;
  await page.routeWebSocket(/\/stream/, (ws) => {
    if (dropping) {
      ws.close();
      return;
    }
    ws.connectToServer();
    sockets.push(ws);
  });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator('.app')).toBeVisible();
  await expect(page.locator('.connection-banner')).toHaveCount(0);

  dropping = true;
  for (const ws of sockets) await ws.close();
  await expect(page.getByRole('alert').filter({ hasText: 'Lost the connection' })).toBeVisible();

  dropping = false;
  await expect(page.locator('.connection-banner')).toHaveCount(0, { timeout: 10_000 });
});

test('the Output node is drawn once and the minimap shows the graph', async ({ page }) => {
  const id = `ux-minimap-${Date.now()}`;
  await page.goto(`/?token=${TOKEN}`);
  await createAgent(page, id);

  // Node cards: the LLM node shows its provider/model chip and an idle status before any run.
  const llm = page.locator('[data-node-type="llm"]');
  await expect(llm.locator('.node-model')).toHaveText('mock/mock-1');
  await expect(llm.locator('.status-pill')).toHaveText('idle');

  // React Flow's built-in `output` type used to add its own border/padding box around ours.
  await expect(page.locator('.react-flow__node-output')).toHaveCount(0);
  const output = page.locator('.react-flow__node:has([data-node-type="output"])');
  await expect(output).toHaveCount(1);
  const wrapper = await output.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, padding: s.paddingTop };
  });
  expect(wrapper).toEqual({ border: '0px', padding: '0px' });

  // The minimap draws one node per canvas node.
  await expect.poll(() => page.locator('.react-flow__minimap-node').count()).toBe(await page.locator('.react-flow__node').count());
});

/**
 * Lands on `#/agents` with the session still authenticated: the redirect only
 * touches the hash, and studioToken.ts has moved `?token=` into sessionStorage.
 * Once the agent list loads, bare `#/agents` is renamed to the open agent's
 * `#/agents/:id` when one is saved (earlier tests save some), so the check
 * waits for that to settle and accepts either form instead of racing it.
 */
async function expectLanded(page: Page, hash: string) {
  await page.waitForLoadState('networkidle');
  const tail = hash === '#/agents' ? '#/agents(/[^/?#]+)?' : hash;
  await expect(page).toHaveURL(new RegExp(`/${tail}$`));
  expect(await page.evaluate(() => sessionStorage.getItem('lousho-studio-token'))).toBe(TOKEN);
  await expect(page.locator('.connection-banner')).toHaveCount(0);
}

test('a ?token= link lands on Agents; the Build toolbar stays on Agents', async ({ page }) => {
  await page.goto(`/?token=${TOKEN}`);
  await expectLanded(page, '#/agents');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Studio surface' })).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Traces' }).click();
  await expectLanded(page, '#/traces');
  await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveText('Traces');
  for (const name of ['Run', 'Stop', 'Import', 'Export', 'Save', 'Debug']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.env-select')).toHaveCount(0);

  await page.goto(`/?token=${TOKEN}#/no-such-screen`);
  await expectLanded(page, '#/agents');
});

const NAV_LABELS = ['Agents', 'Playground', 'Traces', 'Threads', 'Monitoring', 'Evaluations', 'Prompts', 'Context Hub', 'Settings'];

test('the docked nav collapses to an icon rail that survives a reload, every link still named', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/?token=${TOKEN}#/traces`);
  await expectLanded(page, '#/traces');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const card = nav.getByRole('status');
  /** Settings and the collector card are pinned to the nav's bottom edge. */
  const expectCardPinned = async () => {
    await expect
      .poll(async () => {
        const [n, c] = [await nav.boundingBox(), await card.boundingBox()];
        return n && c ? n.y + n.height - (c.y + c.height) : -1;
      })
      .toBeLessThanOrEqual(12);
    const [n, c] = [await nav.boundingBox(), await card.boundingBox()];
    expect(n!.y + n!.height - (c!.y + c!.height)).toBeGreaterThanOrEqual(0);
  };
  await expectCardPinned();
  await nav.getByRole('button', { name: 'Collapse navigation' }).click();
  const expand = nav.getByRole('button', { name: 'Expand navigation' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(56);

  await page.reload();
  await expect(page.locator('.app')).toBeVisible();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(Math.round((await nav.boundingBox())?.width ?? 0)).toBe(56);
  await expectCardPinned();
  for (const name of NAV_LABELS) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Traces', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Threads', exact: true }).click();
  await expectLanded(page, '#/threads');

  // Narrow ignores the collapsed state: the drawer opens full width and closes as before.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(nav.getByRole('button', { name: 'Expand navigation' })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Navigation', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Traces', exact: true })).toBeVisible();
  await expect(nav.locator('.nav-label').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 800 });
  await nav.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(nav.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
});
