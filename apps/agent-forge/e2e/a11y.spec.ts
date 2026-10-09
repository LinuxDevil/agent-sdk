import { test, expect } from '@playwright/test';

/**
 * Eve DUI-F9: keyboard and screen-reader access to the studio - landmarks
 * and a heading, real tablists, labelled controls, a live run status, and
 * palette/hook/toggle controls that work from the keyboard alone.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/?token=e2e-studio-token');
  await expect(page.locator('.app')).toBeVisible();
});

test('the page has landmarks, an h1 and a live run status', async ({ page }) => {
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('navigation')).toHaveCount(1);
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
