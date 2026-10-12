const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: out + n + '.png' }); };
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.fill('#new-agent-name', 'support-demo');
  await page.selectOption('#new-agent-template', 'support-bot');
  await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1500); await shot('05-created-support-bot');
  log('breadcrumb:', await page.locator('.topbar').innerText().catch(() => '?'));
  const nodes = page.locator('.react-flow__node'); log('nodes', await nodes.count(), await nodes.allInnerTexts());
  // select LLM node
  await page.locator('.react-flow__node', { hasText: 'provider' }).first().click(); await shot('06-inspector-llm');
  log('inspector:', (await page.locator('.inspector').innerText()).replace(/\n/g, ' | ').slice(0, 900));
  // tool node
  const toolNode = page.locator('.react-flow__node', { hasText: /http|tool/i }).first();
  if (await toolNode.count()) { await toolNode.click(); await shot('06b-inspector-tool'); log('tool inspector:', (await page.locator('.inspector').innerText()).replace(/\n/g, ' | ').slice(0, 700)); }
  // chat
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.fill('textarea.chat-input', 'My order 1234 is broken, please look it up'); await page.keyboard.press('Enter');
  await page.waitForTimeout(4000); await shot('07-chat-support');
  log('chat:', (await page.locator('.chat-messages').innerText()).replace(/\n/g, ' | ').slice(0, 900));
  log('topbar:', (await page.locator('.topbar').innerText().catch(() => '?')).replace(/\n/g, ' | '));
  // Switch LLM provider to openai without key and run
  await page.locator('.react-flow__node', { hasText: 'provider' }).first().click();
  const selects = page.locator('.inspector select'); log('inspector selects', await selects.count());
  for (let i = 0; i < await selects.count(); i++) log(' select', i, await selects.nth(i).locator('option').allInnerTexts());
  await selects.first().selectOption('openai').catch((e) => log('select fail', e.message));
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await page.waitForTimeout(4000); await shot('08-run-openai-nokey');
  log('topbar after openai run:', (await page.locator('.topbar').innerText().catch(() => '?')).replace(/\n/g, ' | '));
  await page.getByRole('button', { name: 'Logs', exact: true }).click(); await shot('08b-logs-openai-nokey');
  log('logs:', (await page.locator('.drawer-body').innerText()).replace(/\n/g, ' | ').slice(0, 900));
  log('errors:', errs.slice(0, 10));
  await browser.close();
})();
