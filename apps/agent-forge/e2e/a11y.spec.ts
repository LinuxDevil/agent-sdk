import { test, expect } from '@playwright/test';

/**
 * Keyboard and screen-reader access to the studio - landmarks
 * and a heading, real tablists, labelled controls, a live run status, and
 * palette/hook/toggle controls that work from the keyboard alone.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/?token=e2e-studio-token');
  await expect(page.locator('.app')).toBeVisible();
});

test('the page has landmarks, an h1 and a live run status', async ({ page }) => {
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Agents and node palette' })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent Forge');
  await expect(page.locator('.topbar [role="status"][aria-live="polite"]')).toContainText('idle');
});

test('drawer and rail tabs are tablists driven by the arrow keys', async ({ page }) => {
  const drawerTabs = page.getByRole('tablist', { name: 'Run panels' });
  await expect(drawerTabs.getByRole('tab')).toHaveCount(6);
  const chat = drawerTabs.getByRole('tab', { name: 'Chat' });
  await expect(chat).toHaveAttribute('aria-selected', 'true');
  await chat.focus();
  await page.keyboard.press('ArrowRight');
  const logs = drawerTabs.getByRole('tab', { name: 'Logs' });
  await expect(logs).toHaveAttribute('aria-selected', 'true');
  await expect(logs).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Logs' })).toBeVisible();

  const railTabs = page.getByRole('tablist', { name: 'Rail' });
  await railTabs.getByRole('tab', { name: 'Agents' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(railTabs.getByRole('tab', { name: 'Nodes' })).toHaveAttribute('aria-selected', 'true');
});

test('chat controls are labelled', async ({ page }) => {
  await expect(page.getByRole('combobox', { name: 'Past conversations' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('palette items add nodes from the keyboard; hook switch and toggles respond to Enter/Space', async ({ page }) => {
  const nodes = page.locator('.react-flow__node');
  const before = await nodes.count();

  await page.getByRole('tab', { name: 'Nodes' }).click();
  const llmItem = page.getByRole('button', { name: 'LLM step' });
  await llmItem.focus();
  await page.keyboard.press('Enter');
  await expect(nodes).toHaveCount(before + 1);

  // The new LLM node is selected: the Inspector labels its provider/model fields.
  await expect(page.getByRole('combobox', { name: 'Provider' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Model' })).toBeVisible();

  // Attach a pre-hook to the selected node from the keyboard.
  await page.getByRole('button', { name: 'Pre-hook' }).focus();
  await page.keyboard.press('Space');
  const hookSwitch = page.getByRole('switch').first();
  await expect(hookSwitch).toHaveAttribute('aria-checked', 'true');
  await hookSwitch.focus();
  await page.keyboard.press('Enter');
  await expect(hookSwitch).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Space');
  await expect(hookSwitch).toHaveAttribute('aria-checked', 'true');

  // Debug mode exposes the break toggle - a pressed/unpressed button.
  await page.getByRole('button', { name: 'Debug' }).click();
  const breakToggle = page.getByRole('button', { name: 'Breakpoint' });
  await expect(breakToggle).toHaveAttribute('aria-pressed', 'false');
  await breakToggle.focus();
  await page.keyboard.press('Enter');
  await expect(breakToggle).toHaveAttribute('aria-pressed', 'true');

  // Approval gate's "requires approval" chip.
  await page.getByRole('button', { name: 'Approval gate' }).focus();
  await page.keyboard.press('Enter');
  const approvalChip = page.getByRole('button', { name: 'Requires approval' });
  const pressed = await approvalChip.getAttribute('aria-pressed');
  await approvalChip.focus();
  await page.keyboard.press('Space');
  await expect(approvalChip).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
});

test('Ctrl+K opens the command palette; ? lists the shortcuts', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Command' });
  await expect(input).toBeFocused();
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  await input.fill('go to traces');
  await expect(palette.getByRole('listbox', { name: 'Commands' }).getByRole('option')).toHaveText(['Go to Traces']);
  // the combobox's active descendant is a real, selected option
  const activeId = await input.getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/#\/traces$/);

  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(sheet.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

// One <main>, one h1, the banner and the primary nav on every screen, not just Agents.
for (const route of ['#/traces', '#/traces?status=error', '#/traces/e2e-trace?obs=e2e-obs', '#/threads', '#/threads/s1', '#/threads?status=active', '#/monitoring', '#/evals/scores', '#/prompts', '#/prompts/mira@2?diff=1,2', '#/hub', '#/hub/docs?scope=fleet', '#/settings', '#/playground']) {
  test(`${route} keeps the landmarks and exactly one main`, async ({ page }) => {
    await page.goto(`/?token=e2e-studio-token${route}`);
    await expect(page.locator('.screen-main')).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent Forge');
    await expect(page.getByRole('navigation', { name: 'Primary' }).locator('[aria-current="page"]')).toHaveCount(1);
  });
}

test('a #/traces/:id deep link with no daemon shows the down state and keeps the URL', async ({ page }) => {
  // Answer like the studio proxy does for a dead daemon, whatever runs on the machine.
  await page.route('**/observe/**', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' }),
  );
  await page.goto('/?token=e2e-studio-token#/traces/e2e-trace?obs=e2e-obs');
  await expect(page.getByRole('main').getByText('lousho observe start')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/traces/e2e-trace?obs=e2e-obs');
});

test('#/monitoring with no daemon shows the down state and keeps window/agent in the URL', async ({ page }) => {
  await page.route('**/observe/**', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' }),
  );
  await page.goto('/?token=e2e-studio-token#/monitoring?window=7d&agent=e2e-agent');
  await expect(page.getByRole('main').getByText('lousho observe start')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/monitoring?window=7d&agent=e2e-agent');
});

test('#/evals/scores with no daemon shows the down state and keeps the filters in the URL', async ({ page }) => {
  await page.route('**/observe/**', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' }),
  );
  await page.goto('/?token=e2e-studio-token#/evals/scores?eval=e2e-eval&source=eval&range=7d');
  await expect(page.getByRole('main').getByText('lousho observe start')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/evals/scores?eval=e2e-eval&source=eval&range=7d');
});

test('#/settings shows the settings panel inside the screen', async ({ page }) => {
  await page.goto('/?token=e2e-studio-token#/settings');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Settings' })).toBeAttached();
  await expect(main.getByRole('combobox', { name: 'Active profile' })).toBeVisible();
});
