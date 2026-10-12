const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
(async () => {
  const browser = await chromium.launch();
  for (const bad of ['My Agent!', '../evil', 'x'.repeat(120)]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
    await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.fill('#new-agent-name', bad); await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1500);
    const body = (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | ');
    const safe = bad.replace(/[^a-z]/gi, '_').slice(0, 12);
    await page.screenshot({ path: out + `badname-${safe}.png` });
    console.log(JSON.stringify(bad.slice(0, 15)), '\n  body:', body, '\n  errors:', errs.slice(0, 4));
    await page.close();
  }
  await browser.close();
})();
