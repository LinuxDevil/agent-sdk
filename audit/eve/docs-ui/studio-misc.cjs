const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4751/'); await page.waitForTimeout(1200);
  console.log('output node style:', await page.evaluate(() => { const el = document.querySelector('.react-flow__node-output'); const s = getComputedStyle(el); return { cls: el.className, border: s.border, width: s.width, padding: s.padding, inner: el.firstElementChild && getComputedStyle(el.firstElementChild).width }; }));
  console.log('minimap nodes:', await page.evaluate(() => [...document.querySelectorAll('.react-flow__minimap-node')].map(n => n.getAttribute('fill') || getComputedStyle(n).fill)));
  // Nodes palette keyboard
  await page.getByRole('button', { name: 'Nodes', exact: true }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: out + '15-nodes-palette.png' });
  console.log('palette items:', await page.evaluate(() => [...document.querySelectorAll('.node-palette-item')].map(e => ({ t: e.innerText.replace(/\n/g, ' '), tabIndex: e.tabIndex, role: e.getAttribute('role'), onclick: !!e.onclick }))));
  const before = await page.locator('.react-flow__node').count();
  await page.locator('.node-palette-item').first().focus().catch(() => {}); await page.keyboard.press('Enter'); await page.locator('.node-palette-item').first().dblclick(); await page.waitForTimeout(300);
  console.log('nodes before/after Enter+dblclick on palette:', before, await page.locator('.react-flow__node').count());
  // Ctrl+D inside system prompt textarea with LLM node selected
  await page.locator('.react-flow__node', { hasText: 'provider' }).first().click({ position: { x: 40, y: 15 } }); await page.waitForTimeout(300);
  const n0 = await page.locator('.react-flow__node').count();
  await page.locator('#node-prompt').click(); await page.keyboard.press('Control+d'); await page.waitForTimeout(400);
  console.log('nodes before/after Ctrl+D typed inside the System prompt textarea:', n0, await page.locator('.react-flow__node').count());
  // drawer tabs semantics
  console.log('drawer tab roles:', await page.evaluate(() => [...document.querySelectorAll('.drawer-tabs button, .rail-tabs button')].map(b => `${b.innerText}:${b.getAttribute('role')}/${b.getAttribute('aria-selected')}`)));
  console.log('status pill aria-live:', await page.evaluate(() => { const p = document.querySelector('.topbar .status-pill'); return p && (p.closest('[aria-live]') ? 'live' : 'not live'); }));
  // Delete agent affordance?
  console.log('any delete/remove agent control:', await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => /delete|remove|rename/i.test(b.innerText + (b.title || ''))).map(b => b.innerText || b.title)));
  await browser.close();
})();
