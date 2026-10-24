/**
 * Drive the built Studio Observe UI end to end against the live daemon.
 * Run from apps/agent-forge: npx tsx .smoke-ui.mts
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4752/?token=vL_69opXZD_HsceHt608DJaQDxWrDzcy';
const shots = 'E:/agent-sdk/.smoke/shots';
const results: string[] = [];
async function check(name: string, fn: () => Promise<boolean>) {
  try {
    results.push(`${(await fn()) ? 'PASS' : 'FAIL'}  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}  (${e instanceof Error ? e.message : e})`);
  }
}
const text = (page: import('playwright').Page, sel: string) => page.locator(sel).first().textContent({ timeout: 5000 }).catch(() => null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await check('studio loads', async () => (await page.title()) !== '');

// Flip to the Observe surface.
await page.getByRole('button', { name: 'Observe' }).first().click();
await page.waitForSelector('section.observe', { timeout: 10_000 });
await check('observe tabs render', async () => (await page.getByRole('tab').count()) === 4);

// --- Traces tab ---
await page.waitForTimeout(1500);
await check('traces list has smoke-agent rows', async () => (await page.getByText('invoke_agent smoke-agent').count()) >= 2);
await page.screenshot({ path: `${shots}/01-traces.png`, fullPage: true });

// Open the first trace -> waterfall detail.
await page.getByText('invoke_agent smoke-agent').first().click();
await page.waitForTimeout(1200);
await check('trace detail shows generation obs', async () => (await text(page, 'body'))?.includes('chat nvidia') ?? false);
await check('trace detail shows tool call', async () => (await text(page, 'body'))?.includes('get_time') ?? false);
await page.screenshot({ path: `${shots}/02-trace-detail.png`, fullPage: true });
await page.getByRole('button', { name: /back|traces/i }).first().click().catch(() => page.keyboard.press('Escape'));
await page.waitForTimeout(600);

// --- Insights tab ---
await page.getByRole('tab', { name: 'Insights' }).click();
await page.waitForTimeout(1200);
await check('insights shows agent card', async () => (await text(page, 'body'))?.includes('smoke-agent') ?? false);
await check('insights shows latency figure', async () => /p50|p95|3825|4135/i.test((await text(page, 'body')) ?? ''));
await page.screenshot({ path: `${shots}/03-insights.png`, fullPage: true });

// --- Monitoring tab ---
await page.getByRole('tab', { name: 'Monitoring' }).click();
await page.waitForTimeout(1200);
await check('fleet table has smoke-agent', async () => (await text(page, 'body'))?.includes('smoke-agent') ?? false);
await check('fleet table has status', async () => /stopped|healthy|stale|down/i.test((await text(page, 'body')) ?? ''));
await page.screenshot({ path: `${shots}/04-monitoring.png`, fullPage: true });

// --- Scores tab ---
await page.getByRole('tab', { name: 'Scores' }).click();
await page.waitForTimeout(1200);
await check('scores shows eval row', async () => (await text(page, 'body'))?.includes('smoke: eval') ?? false);
await page.screenshot({ path: `${shots}/05-scores.png`, fullPage: true });

await check('no page errors', async () => errors.length === 0);

console.log(results.join('\n'));
if (errors.length) console.log('\npage errors:\n' + errors.slice(0, 5).join('\n'));
await browser.close();
