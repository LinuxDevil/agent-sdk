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
  // The docked Inspector starts collapsed (nothing selected) and opens from its canvas-edge toggle.
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('#/playground at 375px stacks into one column with nothing scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?token=e2e-studio-token#/playground');
  const main = page.getByRole('main');
  // The title is the shell's page header (above <main>); the screen no longer repeats it.
  await expect(page.getByRole('heading', { name: 'Playground', level: 1 })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  // "Save as new prompt version" lives in the card the header's Save prompt button opens.
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(main.getByRole('dialog', { name: 'Save as prompt version' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  for (const name of ['Run', 'Add message', 'Save prompt', 'Save as new prompt version']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375, `${name} is on-screen`).toBe(true);
  }
});

/** Creates a saved support-bot agent (trigger -> llm -> tool -> output) and waits for its first fit. */
async function createSupportBot(page: Page, name: string) {
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(name);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(name);
  await expect(page.locator('[data-node-type="output"]')).toBeVisible();
  await expect(page.locator('.canvas-wrap[data-fitting]')).toHaveCount(0);
}

/** Every node card inside the canvas pane, and each title's on-screen size (computed font-size x viewport zoom). */
async function canvasFit(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    const cards = [...document.querySelectorAll<HTMLElement>('.rf-node')];
    return {
      count: cards.length,
      outside: cards
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < pane.left || r.right > pane.right || r.top < pane.top || r.bottom > pane.bottom;
        })
        .map((el) => el.dataset.nodeType),
      titlePx: Math.min(...cards.map((el) => parseFloat(getComputedStyle(el.querySelector('.rf-node-title')!).fontSize) * zoom)),
    };
  });
}

test('at 1280x800 the default graph opens whole and legible, and selecting a node keeps it in view', async ({ page }) => {
  await open(page, 1280, 800);
  await createSupportBot(page, `fit-${Date.now()}`);
  // Measurement guard: all four nodes inside the pane, titles at >= 10px on screen.
  await expect.poll(async () => (await canvasFit(page)).outside).toEqual([]);
  const fit = await canvasFit(page);
  expect(fit.count).toBe(4);
  expect(fit.titlePx).toBeGreaterThanOrEqual(10);

  // Selecting the right-most node opens the Inspector, and the canvas pans so the node stays visible.
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
  await page.locator('[data-node-type="output"]').click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  const outputInPane = () =>
    page.locator('[data-node-type="output"]').evaluate((el) => {
      const node = el.getBoundingClientRect();
      const pane = el.closest('.react-flow')!.getBoundingClientRect();
      return node.left >= pane.left && node.right <= pane.right;
    });
  await expect.poll(outputInPane).toBe(true);

  // Clicking the empty pane deselects: the Inspector folds away again.
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 60 } });
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
});

test('an explicit Show inspector is remembered across reloads; Hide folds it back', async ({ page }) => {
  await open(page, 1280, 800);
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show inspector' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
});

for (const [width, height] of [
  [1440, 900],
  [1920, 1080],
  [860, 800],
] as const) {
  test(`at ${width}x${height} the default graph opens whole and legible`, async ({ page }) => {
    // Created at 1280 (below 860 the rail is a drawer), then reopened at the target size.
    await open(page, 1280, 800);
    const name = `fit-${width}-${Date.now()}`;
    await createSupportBot(page, name);
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator('.crumbs b')).toHaveText(name);
    await expect(page.locator('.canvas-wrap[data-fitting]')).toHaveCount(0);
    await expect.poll(async () => (await canvasFit(page)).outside).toEqual([]);
    expect((await canvasFit(page)).titlePx).toBeGreaterThanOrEqual(10);
  });
}
