// Opens the studio, waits for the server to be killed externally, then screenshots and tries actions.
const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1200);
  fs.writeFileSync('E:/agent-sdk/audit/eve/docs-ui/.ready', '1');
  while (fs.existsSync('E:/agent-sdk/audit/eve/docs-ui/.ready')) await page.waitForTimeout(300);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Run', exact: true }).click().catch(() => {}); await page.waitForTimeout(1500);
  await page.fill('textarea.chat-input', 'are you there?'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await page.screenshot({ path: 'E:/agent-sdk/audit/eve/docs-ui/shots/16-server-down.png' });
  console.log('topbar:', (await page.locator('.topbar').innerText()).replace(/\n/g, ' | '));
  console.log('chat:', (await page.locator('.chat-panel').innerText()).replace(/\n/g, ' | ').slice(0, 400));
  await browser.close();
})();
