import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** A stylesheet under src/, as text without its comments. */
const sheet = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list includes `selector` (exactly), joined. */
function rulesFor(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out.join('\n');
}

describe('the nav drawer scrim', () => {
  it('is a --scrim light-dark() token, not a raw colour in shell.css', () => {
    expect(sheet('theme.css')).toMatch(/--scrim:\s*light-dark\(\s*rgb\(10 12 18 \/ 0\.35\),\s*rgb\(0 0 0 \/ 0\.55\)\s*\)/);
    const scrim = rulesFor(sheet('shell/shell.css'), '.app-shell-scrim');
    expect(scrim).toMatch(/background:\s*var\(--scrim\)/);
    expect(sheet('shell/shell.css')).not.toMatch(/rgba?\(/);
  });
});

describe('sticky side panels', () => {
  // `.screen-main` is the scroll container under the screen header; the panels measure their cap against it.
  it('.screen-main is a size container', () => {
    expect(rulesFor(sheet('components/layout.css'), '.screen-main')).toMatch(/container-type:\s*size/);
  });

  // Each panel sticks at `top: var(--space-4)`; capped to the scroll container's height less that top and a bottom gap.
  const cap = /max-height:\s*calc\(100cqh - 2 \* var\(--space-4\)\)/;
  it.each([
    ['screens/queues/queues.css', '.qu-review > .qu-rubric-card'],
    ['screens/hub/hub.css', '.hub-split > .hub-entry'],
  ])('%s: %s fits the scroll container', (file, selector) => {
    const rules = rulesFor(sheet(file), selector);
    expect(rules).toMatch(/position:\s*sticky/);
    expect(rules).toMatch(/top:\s*var\(--space-4\)/);
    expect(rules).toMatch(cap);
    expect(rules).not.toMatch(/100dvh/);
  });

  it('the rubric card scrolls its fields, so Skip / Submit & next stay pinned at its foot', () => {
    const css = sheet('screens/queues/queues.css');
    expect(rulesFor(css, '.qu-review > .qu-rubric-card')).toMatch(/overflow:\s*hidden/);
    const body = rulesFor(css, '.qu-review > .qu-rubric-card > .qu-rubric-body');
    expect(body).toMatch(/overflow:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it('the hub entry scrolls inside itself', () => {
    expect(rulesFor(sheet('screens/hub/hub.css'), '.hub-split > .hub-entry')).toMatch(/overflow:\s*auto/);
  });
});
