import { test, expect, type Locator, type Page } from '@playwright/test';
import { ROUTES, type ScreenId } from '../src/screens/routeTable';
import { stubObserve } from './observeStub';
import { SEED_ERROR, SEED_NEWEST_FAILURE, SEED_OLD_SLOW, SEED_SLOWEST_24H, seedObserve } from './fixtures/seedObserve';

/**
 * The Studio revamp's success metrics as acceptance tests, against the seeded
 * fake daemon (`fixtures/seedObserve.ts` over `observeStub.ts`). Interaction
 * counts start at app load (`/?token=...`) and count clicks, selects and key
 * presses only; each counted step is numbered in a comment.
 *
 * The fifth metric, axe with zero serious/critical violations on every screen,
 * is `a11y.spec.ts` (it iterates the same route table).
 */
const APP = '/?token=e2e-studio-token';

test.beforeEach(async ({ page }) => {
  await stubObserve(page);
  await seedObserve(page);
});

/** Counts the user interactions a metric spends. */
function counter() {
  let n = 0;
  return {
    step: async (action: () => Promise<unknown>) => {
      n += 1;
      await action();
    },
    get count() {
      return n;
    },
  };
}

const primaryNav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
/** Data rows only: a first load shows skeleton rows (`.skeleton-row`) until the rows arrive. */
const bodyRows = (page: Page) => page.getByRole('main').locator('table.data-table tbody tr:not(.skeleton-row)');

async function openApp(page: Page, hash = '') {
  await page.goto(`${APP}${hash ? `#${hash}` : ''}`);
  await expect(page.locator('.app')).toBeVisible();
}

test('a failed run shows its error text in 2 interactions from app load', async ({ page }) => {
  const ui = counter();
  await openApp(page);

  // 1. Click "Traces" in the Primary nav: the failed row shows its error_message.
  await ui.step(() => primaryNav(page).getByRole('link', { name: 'Traces' }).click());
  const failedRow = bodyRows(page).filter({ hasText: SEED_ERROR }).first();
  await expect(failedRow).toBeVisible();
  await expect(failedRow).toContainText(SEED_NEWEST_FAILURE.input_preview!);

  // 2. Open that row: the Error banner shows the error text.
  await ui.step(() => failedRow.click());
  await expect(page.getByRole('main').getByRole('alert')).toContainText(SEED_ERROR);
  expect(new URL(page.url()).hash).toBe(`#/traces/${SEED_NEWEST_FAILURE.trace_id}`);

  expect(ui.count).toBe(2);
});

test('the slowest run in the last 24 h is the first row in 3 interactions', async ({ page }) => {
  const ui = counter();
  await openApp(page);
  const main = page.getByRole('main');
  const range = main.getByRole('group', { name: 'Time range' });

  const tracesRequests: URL[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === '/observe/api/v1/traces') tracesRequests.push(url);
  });
  /** The newest traces request asks the daemon for the last 24 h (half-open, ending about now). */
  const expectLast24h = () => {
    const q = tracesRequests[tracesRequests.length - 1]?.searchParams;
    const from = Number(q?.get('from'));
    const to = Number(q?.get('to'));
    expect(to - from, 'window length').toBe(86_400_000);
    expect(Math.abs(Date.now() - to), 'window ends now').toBeLessThan(60_000);
    return q!;
  };

  // 1. Traces.
  await ui.step(() => primaryNav(page).getByRole('link', { name: 'Traces' }).click());
  await expect(bodyRows(page).first()).toBeVisible();
  // 2. Time range "24h" (a visible preset, one click). It is the default window, so the URL stays bare
  //    (defaults are never written) and the list keeps asking for the last 24 h.
  await ui.step(() => range.getByRole('button', { name: '24h', exact: true }).click());
  await expect(range.getByRole('button', { name: '24h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#/traces');
  expectLast24h();
  // 3. Sort by duration (slowest first on the first click).
  await ui.step(() => main.getByRole('button', { name: 'Duration' }).click());
  await expect(main.getByRole('columnheader', { name: 'Duration' })).toHaveAttribute('aria-sort', 'descending');
  expect(new URL(page.url()).hash).toBe('#/traces?sort=duration&order=desc');
  await expect.poll(() => tracesRequests[tracesRequests.length - 1]?.searchParams.get('sort')).toBe('duration');
  expect(expectLast24h().get('order')).toBe('desc');
  await expect(bodyRows(page).first()).toContainText(SEED_SLOWEST_24H.input_preview!);
  await expect(bodyRows(page).first()).toContainText('2.6s');
  expect(ui.count).toBe(3);

  // Not part of the metric: the window is what keeps the older, slower run out.
  await range.getByRole('button', { name: '7d', exact: true }).click();
  await expect(bodyRows(page).first()).toContainText(SEED_OLD_SLOW.input_preview!);
  await expect(bodyRows(page).first()).toContainText('3.4s');
});

// --- Every screen survives a reload at its URL with the same filters --------

const FROM = Date.now() - 6 * 3_600_000;
const TO = Date.now();

/**
 * A non-default filter query per screen (applied to every route of that
 * screen). Typed as a full Record so a new ScreenId fails the typecheck until
 * it is given one; '' for screens without URL filters.
 */
const FILTERS: Record<ScreenId, string> = {
  agents: '',
  playground: '?trace=e2e-trace&fromObs=e2e-obs',
  traces: `?agent=orders-bot&status=error&q=order&from=${FROM}&to=${TO}&sort=duration&order=desc`,
  trace: '?obs=e2e-obs',
  threads: `?agent=orders-bot&status=ended&from=${FROM}&to=${TO}`,
  monitoring: '?window=7d&agent=orders-bot',
  scores: '?eval=e2e-eval&agent=orders-bot&source=eval&range=7d&open=e2e-eval',
  // The only URL state Datasets keeps is the server-side page (`offset`).
  datasets: '?offset=50',
  // Queues pages server-side the same way (`?offset=`).
  queues: '?offset=50',
  // The list's kind/state filters (ridden along on the edit view for its way back) and the edit view's test-on-trace prefill.
  evaluators: '?kind=code&enabled=true&trace=e2e-trace',
  prompts: '?diff=1,2',
  hub: '?agent=triage-bot&scope=fleet',
  settings: '',
};

const pad = (n: number) => String(n).padStart(2, '0');
/** Epoch ms as the `YYYY-MM-DDTHH:mm` local string the range's datetime-local inputs show. */
function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A facet dropdown shows `option` ticked (opened and closed again). */
async function expectFacet(main: Locator, label: string, option: string) {
  await main.getByRole('button', { name: label }).first().click();
  await expect(main.getByRole('group', { name: label }).getByRole('checkbox', { name: option })).toBeChecked();
  await main.getByRole('button', { name: label }).first().click();
}

async function expectCustomRange(main: Locator) {
  const range = main.getByRole('group', { name: 'Time range' });
  await expect(range.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  await expect(range.getByLabel('From')).toHaveValue(localInput(FROM));
  await expect(range.getByLabel('To')).toHaveValue(localInput(TO));
}

/** The pager is past page one (`?offset=`): Previous is enabled. */
async function expectPreviousPage(main: Locator) {
  await expect(main.locator('.dt-pager').getByRole('button', { name: 'Previous' })).toBeEnabled();
}

/** What each screen's filter controls must show after the reload (list routes; detail routes keep only the URL). */
const CONTROLS: Record<string, (main: Locator, page: Page) => Promise<void>> = {
  '/agents/:id': async (_main, page) => {
    await expect(page.locator('.crumbs b')).toHaveText(SAVED_AGENT);
  },
  '/traces': async (main) => {
    await expect(main.getByRole('searchbox')).toHaveValue('order');
    await expectFacet(main, 'Agent', 'Orders bot');
    await expectFacet(main, 'Status', 'error');
    await expectCustomRange(main);
    await expect(main.getByRole('columnheader', { name: 'Duration' })).toHaveAttribute('aria-sort', 'descending');
  },
  '/traces/:traceId': async (main) => {
    // The inspector shows the `?obs=` step (the default selection would be the root, "support turn").
    await expect(main.getByRole('heading', { name: 'llm', level: 2 })).toBeVisible();
  },
  '/threads': async (main) => {
    await expectFacet(main, 'Agent', 'Orders bot');
    await expectFacet(main, 'Status', 'ended');
    await expectCustomRange(main);
  },
  // The window and agent controls sit in the screen header, above <main>.
  '/monitoring': async (_main, page) => {
    await expect(page.getByRole('group', { name: 'Window' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('orders-bot');
  },
  '/evals/scores': async (main) => {
    await expect(main.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    await expectFacet(main, 'Eval', 'e2e-eval');
    await expectFacet(main, 'Agent', 'Orders bot');
    await expectFacet(main, 'Source', 'eval');
    await expect(main.getByRole('region', { name: 'Eval e2e-eval' })).toBeVisible();
  },
  '/evals/datasets': async (main) => {
    await expectPreviousPage(main);
  },
  '/evals/datasets/:name': async (main) => {
    await expectPreviousPage(main);
  },
  '/evals/queues': async (main) => {
    await expectPreviousPage(main);
  },
  '/evals/evaluators': async (main) => {
    await expect(main.getByRole('combobox', { name: 'Kind' })).toHaveValue('code');
    await expect(main.getByRole('combobox', { name: 'State' })).toHaveValue('true');
    await expect(main.getByRole('switch', { name: 'answered enabled' })).toBeChecked();
  },
  '/evals/evaluators/:id': async (main, page) => {
    await expect(main.getByRole('textbox', { name: 'Trace id' })).toHaveValue('e2e-trace');
    // The way back is the header breadcrumb (the screen header sits outside <main>).
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Evaluators' })).toHaveAttribute('href', '#/evals/evaluators?kind=code&enabled=true');
  },
  '/prompts/:name': async (main) => {
    await expect(main.getByRole('combobox', { name: 'Compare version A' })).toHaveValue('1');
    await expect(main.getByRole('combobox', { name: 'Compare version B' })).toHaveValue('2');
  },
  '/hub': async (main) => {
    await expect(main.getByRole('combobox', { name: 'Viewing as' })).toHaveValue('triage-bot');
    await expect(main.getByRole('combobox', { name: 'Scope' })).toHaveValue('fleet');
  },
  '/playground': async (main) => {
    await expect(main.getByRole('textbox', { name: 'Content of message 1' })).toHaveValue('Where is my order?');
  },
};
CONTROLS['/hub/:namespace'] = CONTROLS['/hub'];

/**
 * Routes with no filter controls of their own to re-check (the reload still
 * checks the hash and the screen). A route in neither CONTROLS nor here fails.
 */
const NO_CONTROLS = new Set([
  '/agents', // canonicalises to the open agent; nothing to filter
  '/threads/:sessionId', // a thread's turns; the list's filters only ride along in the URL
  '/evals/queues/:id', // one queue's review pane; no URL-backed controls beyond the id
  '/prompts', // the registry list has no filters
  '/settings', // no URL state
]);

/** What identifies the screen: the current Primary nav item and the screen's first heading (Agents' builder has none). */
async function screenIdentity(page: Page) {
  await page.waitForLoadState('networkidle');
  const nav = await primaryNav(page).locator('[aria-current="page"]').innerText();
  const headings = page.getByRole('main').getByRole('heading');
  const heading = (await headings.count()) > 0 ? await headings.first().textContent() : null;
  return { nav, heading };
}

/** The saved agent `#/agents/e2e-agent` names (an unknown id falls back to `#/agents` by design). */
const SAVED_AGENT = 'e2e-agent';
const API = { headers: { 'x-lousho-studio-token': 'e2e-studio-token' } };

async function ensureSavedAgent(page: Page) {
  const ids = ((await (await page.request.get('/agents', API)).json()) as { id: string }[]).map((a) => a.id);
  if (ids.includes(SAVED_AGENT)) return;
  await openApp(page);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(SAVED_AGENT);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(SAVED_AGENT);
}

for (const { pattern, screen, example } of ROUTES) {
  test(`${pattern} survives a reload with its filters`, async ({ page }) => {
    // Guards for a route added after this suite (the typecheck catches a missing FILTERS key too).
    const filters = FILTERS[screen] as string | undefined;
    expect(filters, `FILTERS has no entry for screen '${screen}' (${pattern}): add its filter query, '' if none`).toBeDefined();
    const controls = CONTROLS[pattern] as ((main: Locator, page: Page) => Promise<void>) | undefined;
    expect(
      controls !== undefined || NO_CONTROLS.has(pattern),
      `route ${pattern} has no CONTROLS check: add one, or list it in NO_CONTROLS`,
    ).toBe(true);
    expect(controls !== undefined && NO_CONTROLS.has(pattern), `route ${pattern} is in both CONTROLS and NO_CONTROLS`).toBe(false);

    if (screen === 'agents') await ensureSavedAgent(page);
    const hash = `#${example}${filters}`;
    await openApp(page, `${example}${filters}`);
    const main = page.getByRole('main');
    await controls?.(main, page);
    const before = await screenIdentity(page);
    const settled = new URL(page.url()).hash;
    // Bare #/agents is replaced by the open agent's #/agents/:id (its canonical URL); every other URL stays as given.
    if (pattern === '/agents') expect(settled).toMatch(/^#\/agents(\/[^/?]+)?$/);
    else expect(settled).toBe(hash);

    await page.reload();
    await expect(page.locator('.app')).toBeVisible();
    expect(await screenIdentity(page)).toEqual(before);
    expect(new URL(page.url()).hash).toBe(settled);
    await controls?.(main, page);
  });
}

// --- Narrow: the nav is a drawer and nothing scrolls sideways --------------
// (narrow.spec.ts covers the Agents builder's own drawers and More menu.)

for (const width of [860, 375]) {
  for (const { pattern, example } of ROUTES) {
    test(`${pattern} at ${width}px: nav is a drawer, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page, example);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

      const nav = page.locator('#primary-nav');
      const toggle = page.getByRole('button', { name: 'Navigation', exact: true });
      await expect(nav).toBeHidden();
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(nav).toBeVisible();
      // Wait out the slide-in, then check the drawer sits on-screen.
      await expect.poll(async () => Math.round((await nav.boundingBox())?.x ?? -1)).toBe(0);
      await page.keyboard.press('Escape');
      await expect(nav).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    });
  }
}

test('queue review at 1280px: a trace tree row name never wraps one letter per line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP}#/evals/queues/e2e-queue`);
  await expect(page.locator('[data-review-trace="e2e-trace"]')).toBeVisible();
  // The review opens on the root step's messages; the tree is the Trace view.
  await page.getByRole('group', { name: 'Item view' }).getByRole('button', { name: 'Trace' }).click();
  const names = page.locator('[data-review-trace="e2e-trace"] .run-name');
  await expect(names.first()).toBeVisible();
  for (const name of await names.all()) {
    const box = (await name.boundingBox())!;
    const line = await name.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || el.getBoundingClientRect().height);
    expect(box.height, `${await name.textContent()} wraps`).toBeLessThanOrEqual(line * 2 + 1);
  }
});

// The traces columns are sized to fit a 1280px window with the nav expanded, so the wrap only clips and the
// header can stick; columns resized past the screen make the wrap scroll sideways instead (the header stops sticking).
// At 1920 every column but the widest-only ones shows, and it still fits and sticks.
test('traces at 1280px: the table fits its wrap, and resized past the screen it scrolls sideways inside it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP}#/traces`);
  await expect(bodyRows(page).first()).toBeVisible();
  const wrap = page.getByRole('main').locator('.data-table-wrap');
  await expect(wrap).not.toHaveClass(/dt-scroll-x/);
  expect(await wrap.evaluate((w) => w.scrollWidth <= w.clientWidth)).toBe(true);

  // A remembered column width wider than the screen (as if dragged there) overflows the wrap.
  await page.evaluate(() => window.localStorage.setItem('forge.table.traces.widths', JSON.stringify({ input: 900 })));
  await page.reload();
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(wrap).toHaveClass(/dt-scroll-x/);
  expect(await wrap.evaluate((w) => w.scrollWidth > w.clientWidth && getComputedStyle(w).overflowX === 'auto')).toBe(true);
});

test('traces at 1920px: the table header stays in view while the screen scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  await page.goto(`${APP}#/traces`);
  await expect(bodyRows(page).nth(30)).toBeVisible();
  await expect(page.getByRole('main').locator('.data-table-wrap')).not.toHaveClass(/dt-scroll-x/);
  const header = page.getByRole('main').locator('table.data-table thead th').first();
  const before = (await header.boundingBox())!;
  // Scroll the screen's own scroller (the nearest scrollable ancestor of the table) by 600px.
  const scrolled = await header.evaluate((th) => {
    let el: HTMLElement | null = th.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (!el) return 0;
    el.scrollTop += 600;
    return el.scrollTop;
  });
  expect(scrolled, 'the screen scrolls').toBeGreaterThan(300);
  await expect.poll(async () => (await header.boundingBox())!.y).toBeLessThan(before.y + 1);
  const after = (await header.boundingBox())!;
  expect(after.y, 'header still in the viewport').toBeGreaterThanOrEqual(0);
  expect(after.y + after.height).toBeLessThanOrEqual(800);
  // ...and it is the sticky header that kept it there, not a page that did not move.
  await expect(bodyRows(page).first()).not.toBeInViewport();
});
