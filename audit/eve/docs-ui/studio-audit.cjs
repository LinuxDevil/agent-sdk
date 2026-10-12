// Agent Forge studio a11y/responsive probe. Usage: node studio-audit.cjs <url>
const { chromium } = require('E:/agent-sdk/node_modules/playwright');
const url = process.argv[2] || 'http://127.0.0.1:4751/';
const out = 'E:/agent-sdk/audit/eve/docs-ui/shots/';
(async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const [name, w, h] of [['desktop', 1440, 900], ['tablet', 768, 1024], ['mobile', 375, 812]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(url); await page.waitForTimeout(1500);
    await page.screenshot({ path: out + `home-${name}.png` });
    report[name] = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && [...el.labels].map(l => l.innerText).join(' ')) || el.innerText || el.getAttribute('placeholder') || '').trim();
      const unnamed = [...document.querySelectorAll('button,a,input,select,textarea,[role=button],[role=tab],[role=switch]')].filter(vis).filter(el => !name(el)).map(el => el.outerHTML.slice(0, 160));
      const noLabel = [...document.querySelectorAll('input,select,textarea')].filter(vis).filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map(el => el.outerHTML.slice(0, 160));
      // contrast
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
      const low = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      while (walker.nextNode()) { const t = walker.currentNode; const el = t.parentElement; if (!el || seen.has(el) || !t.textContent.trim() || !vis(el)) continue; seen.add(el);
        const s = getComputedStyle(el); const fg = parse(s.color); if (!fg) continue; const bg = bgOf(el);
        const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight) >= 700; const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
        if (ratio < need) low.push(`${ratio.toFixed(2)} (${s.color} on rgb(${bg.r},${bg.g},${bg.b}), ${size}px) "${t.textContent.trim().slice(0, 40)}"`); }
      const overflowX = document.documentElement.scrollWidth > innerWidth;
      const offscreen = [...document.querySelectorAll('button,a,input,[role=tab]')].filter(vis).filter(el => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).map(el => name(el).slice(0, 30));
      const small = [...document.querySelectorAll('button,a,input,[role=tab],[role=switch]')].filter(vis).filter(el => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map(el => `${name(el).slice(0, 25) || el.outerHTML.slice(0, 60)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
      return { title: document.title, landmarks: [...document.querySelectorAll('main,nav,header,aside,[role=main],[role=navigation],[role=banner],[role=complementary]')].map(e => e.tagName + (e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : '')), h1: [...document.querySelectorAll('h1,h2,h3')].map(h => h.tagName + ':' + h.innerText.slice(0, 30)), unnamed, noLabel, lowContrast: low, overflowX, scrollW: document.documentElement.scrollWidth, offscreen, smallTargets: small };
    });
    if (name === 'desktop') {
      // keyboard tab walk
      const stops = [];
      for (let i = 0; i < 45; i++) { await page.keyboard.press('Tab'); stops.push(await page.evaluate(() => { const el = document.activeElement; if (!el) return 'null'; const s = getComputedStyle(el); const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none'; return `${el.tagName}${el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''} "${(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 30)}" ring=${ring}`; })); }
      report.tabWalk = stops;
      await page.screenshot({ path: out + 'home-desktop-focus.png' });
    }
    await page.close();
  }
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
