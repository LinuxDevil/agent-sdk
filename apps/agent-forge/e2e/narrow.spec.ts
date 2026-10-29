import { test, expect, type Page } from '@playwright/test';

/**
 * Below 860px the studio used to hide the rail and Inspector
 * outright and push Save, the zoom controls and Send off-screen (826px of
 * page at a 375px viewport). Now the rail and Inspector are slide-over
 * drawers toggled from the top bar, Run and Save stay in the bar, and
 * Debug/Import/Export live in a "More" menu.
 */
async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/?token=e2e-studio-token');
  await expect(page.locator('.app')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test('at 375px nothing scrolls sideways and every control is reachable', async ({ page }) => {
  await open(page, 375, 812);
  expect(await horizontalOverflow(page)).toBe(0);

  for (const name of ['Run', 'Save', 'More actions', 'Agents and nodes', 'Inspector', 'Send']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375, `${name} is on-screen`).toBe(true);
  }
});

test('the rail and the Inspector open as drawers and close with Escape or the scrim', async ({ page }) => {
  await open(page, 375, 812);
  const rail = page.getByRole('navigation', { name: 'Agents and node palette' });
  const railToggle = page.getByRole('button', { name: 'Agents and nodes' });
  await expect(rail).toBeHidden();

  await railToggle.click();
  await expect(railToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('button', { name: 'New agent', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail).toBeHidden();

  const inspectorToggle = page.getByRole('button', { name: 'Inspector', exact: true });
  await inspectorToggle.click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  // Wait out the slide-in transition, then check it sits fully on-screen.
  await expect
    .poll(async () => {
      const box = await inspector.boundingBox();
      return box ? Math.round(box.x + box.width) : -1;
    })
    .toBe(375);
  await page.locator('.shell-scrim').click({ position: { x: 20, y: 200 } });
  await expect(inspector).toBeHidden();
  expect(await horizontalOverflow(page)).toBe(0);
});

test('Debug, Import and Export live in the More menu; Save stays in the bar', async ({ page }) => {
  await open(page, 375, 812);
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Debug' })).toBeFocused();
  for (const name of ['Import', 'Export']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  await expect(page.locator('.topbar').getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();
});

test('at 1280px the three-column layout has no drawer toggles', async ({ page }) => {
  await open(page, 1280, 800);
  expect(await horizontalOverflow(page)).toBe(0);
  await expect(page.getByRole('navigation', { name: 'Agents and node palette' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('#/playground at 375px stacks into one column with nothing scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?token=e2e-studio-token#/playground');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Playground' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  for (const name of ['Run', 'Add message', 'Save as new prompt version']) {
    const box = await main.getByRole('button', { name, exact: true }).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375, `${name} is on-screen`).toBe(true);
  }
});
