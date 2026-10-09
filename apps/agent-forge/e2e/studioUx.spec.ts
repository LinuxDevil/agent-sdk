import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * Eve DUI-F21: status, copy and naming match the docs - a finished run says
 * `done`, Run's prompt is labelled "Run input" in Chat, a new agent is named
 * what you typed, the open agent can be renamed and deleted, and a dropped
 * server connection is announced.
 */
const TOKEN = 'e2e-studio-token';
const API = { headers: { 'x-lousho-studio-token': TOKEN } };

async function createAgent(page: Page, id: string) {
  await page.getByRole('button', { name: '+ New agent' }).click();
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

  const runBubble = page.locator('.chat-msg.run-input');
  await expect(runBubble).toBeVisible();
  await expect(runBubble).toContainText('Run input');
  await expect(page.locator('.chat-msg.user:not(.run-input)')).toHaveCount(0);
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

test('the Output node is drawn once and the minimap shows the graph (Eve DUI-F22)', async ({ page }) => {
  const id = `ux-minimap-${Date.now()}`;
  await page.goto(`/?token=${TOKEN}`);
  await createAgent(page, id);

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
