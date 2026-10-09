import { test, expect, type Page } from '@playwright/test';

/**
 * Eve DUI-F8: below 860px the studio used to hide the rail and Inspector
 * outright and push Save, the zoom controls and Send off-screen (826px of
 * page at a 375px viewport). Now the rail and Inspector are slide-over
 * drawers toggled from the top bar and Debug/Import/Export/Save live in a
 * "More" menu.
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

  for (const name of ['Run', 'More actions', 'Agents and nodes', 'Inspector', 'Send']) {
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
  await expect(rail.getByRole('button', { name: '+ New agent' })).toBeVisible();
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

test('Debug, Import, Export and Save live in the More menu', async ({ page }) => {
  await open(page, 375, 812);
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Debug' })).toBeFocused();
  for (const name of ['Import', 'Export', 'Save']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
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
