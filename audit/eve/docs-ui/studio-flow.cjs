// Drives Agent Forge flows with Playwright and screenshots each state.
const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const url = 'http://127.0.0.1:4751/';
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));
  const shot = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: out + n + '.png' }); log('shot', n); };
  await page.goto(url); await page.waitForTimeout(1200);
  // 1. Run the unsaved default agent
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForTimeout(2500); await shot('01-run-unsaved');
  log('topbar text:', (await page.locator('.topbar, header').first().innerText().catch(() => '')).replace(/\n/g, ' | '));
  // drawer tabs
  for (const t of ['Logs', 'Trace', 'Output', 'History', 'Settings']) { await page.getByRole('button', { name: t, exact: true }).click(); await shot('02-tab-' + t); log(t + ' drawer:', (await page.locator('.drawer, .bottom-drawer').first().innerText().catch(() => '?')).slice(0, 400).replace(/\n/g, ' | ')); }
  // 2. New agent
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: '+ New agent' }).click(); await shot('03-new-agent-form');
  const opts = await page.locator('#new-agent-template option').allInnerTexts(); log('templates:', opts);
  // invalid names
  for (const bad of ['My Agent!', '../evil', 'a'.repeat(120)]) {
    await page.fill('#new-agent-name', bad); await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(800);
    log('create', JSON.stringify(bad.slice(0, 20)), '->', (await page.locator('.run-error').allInnerTexts()).join(' / ') || '(no topbar error)', '| rail:', (await page.locator('.rail').innerText()).slice(0, 200).replace(/\n/g, ' | '));
  }
  await shot('04-after-bad-names');
  await page.reload(); await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.fill('#new-agent-name', 'support-demo');
  await page.selectOption('#new-agent-template', { index: 1 }).catch(() => {});
  await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1200); await shot('05-created-template');
  // select first node
  const nodes = page.locator('.react-flow__node'); log('node count', await nodes.count());
  await nodes.first().click(); await shot('06-inspector-node');
  log('inspector:', (await page.locator('.inspector').innerText()).slice(0, 800).replace(/\n/g, ' | '));
  // 3. chat
  await page.fill('textarea.chat-input', 'hello there, what can you do?'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); await shot('07-chat');
  log('chat:', (await page.locator('.chat-messages').innerText()).slice(0, 600).replace(/\n/g, ' | '));
  log('console:', consoleErrs.slice(0, 20));
  await browser.close();
})();
