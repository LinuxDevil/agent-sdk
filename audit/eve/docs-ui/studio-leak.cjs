// Usage: node studio-leak.cjs <phase: create|inspect>
const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const phase = process.argv[2];
(async () => {
  const ctx = await chromium.launchPersistentContext('E:/agent-sdk/audit/eve/docs-ui/.pw-profile', { viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1200);
  if (phase === 'create') {
    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.fill('#new-agent-name', 'project-a-secret-agent');
    await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1200);
  }
  console.log(phase, 'rail:', (await page.locator('.rail').innerText()).replace(/\n/g, ' | '));
  console.log(phase, 'server /agents:', await page.evaluate(() => fetch('/agents').then(r => r.json()).then(a => a.map(x => x.id))));
  await page.screenshot({ path: `E:/agent-sdk/audit/eve/docs-ui/shots/leak-${phase}.png` });
  await ctx.close();
})();
