const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.fill('#new-agent-name', 'My Agent'); await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1500);
  await page.screenshot({ path: out + 'badname-space-crash.png' });
  console.log('after create body len', (await page.locator('body').innerText()).length);
  console.log(errs.filter(e => !e.startsWith('Failed to load')).join('\n---\n').slice(0, 2500));
  console.log('localStorage:', await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, v.slice(0, 120)])))));
  await page.reload(); await page.waitForTimeout(1500);
  console.log('after reload body:', (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | '));
  await page.screenshot({ path: out + 'badname-space-after-reload.png' });
  await browser.close();
})();
