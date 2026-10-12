const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
  const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: out + n + '.png' }); };
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.fill('#new-agent-name', 'err-demo');
  await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(1500);
  await page.locator('.react-flow__node', { hasText: 'provider' }).first().click({ position: { x: 40, y: 15 } }); await page.waitForTimeout(500);
  log('inspector:', (await page.locator('.inspector').innerText()).replace(/\n/g, ' | ').slice(0, 300));
  log('unlabeled in inspector:', await page.evaluate(() => [...document.querySelectorAll('.inspector input,.inspector select,.inspector textarea')].filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map(el => el.outerHTML.slice(0, 90))));
  await page.locator('.inspector select').first().selectOption('openai'); await page.waitForTimeout(600);
  await shot('09-provider-openai-selected');
  log('topbar env pill:', await page.locator('.env-select').innerText());
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await page.waitForTimeout(5000); await shot('10-run-openai-nokey');
  log('topbar:', (await page.locator('.topbar').innerText()).replace(/\n/g, ' | '));
  log('run-error full:', await page.locator('.run-error').allInnerTexts(), 'aria-live?', await page.locator('[aria-live],[role=alert],[role=status]').count());
  const box = await page.locator('.run-error').first().boundingBox().catch(() => null); log('run-error box', box);
  await page.getByRole('button', { name: 'Logs', exact: true }).click(); await shot('11-logs-openai-nokey');
  log('logs:', (await page.locator('.drawer-body').innerText()).replace(/\n/g, ' | ').slice(0, 700));
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await shot('12-chat-after-error');
  log('chat:', (await page.locator('.chat-messages').innerText()).replace(/\n/g, ' | ').slice(0, 500));
  // Import invalid YAML
  const fs = require('fs'); fs.writeFileSync(out + 'bad.yaml', 'spec:\n  name: [unclosed\n');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.getByRole('button', { name: 'Import', exact: true }).click()]);
  if (chooser) { await chooser.setFiles(out + 'bad.yaml'); await page.waitForTimeout(1200); await shot('13-import-bad-yaml'); log('after bad import topbar:', (await page.locator('.topbar').innerText()).replace(/\n/g, ' | ')); }
  fs.writeFileSync(out + 'bad2.yaml', 'spec:\n  name: x\n  provider: { type: nope }\n');
  const [ch2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.getByRole('button', { name: 'Import', exact: true }).click()]);
  if (ch2) { await ch2.setFiles(out + 'bad2.yaml'); await page.waitForTimeout(1200); await shot('14-import-bad-schema'); log('after schema-bad import:', (await page.locator('.topbar').innerText()).replace(/\n/g, ' | '), '| rail:', (await page.locator('.rail').innerText()).replace(/\n/g, ' | ')); }
  log('errs:', errs);
  await browser.close();
})();
