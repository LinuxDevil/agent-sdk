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
  // Each panel sticks at `top: var(--space-4)`; capped below the viewport so its footer buttons stay reachable.
  const cap = /max-height:\s*calc\(100dvh - var\(--space-4\) - var\(--space-4\)\)/;
  it.each([
    ['screens/queues/queues.css', '.qu-review > .qu-rubric-card'],
    ['screens/hub/hub.css', '.hub-split > .hub-entry'],
  ])('%s: %s scrolls inside the viewport', (file, selector) => {
    const rules = rulesFor(sheet(file), selector);
    expect(rules).toMatch(/position:\s*sticky/);
    expect(rules).toMatch(/top:\s*var\(--space-4\)/);
    expect(rules).toMatch(cap);
    expect(rules).toMatch(/overflow:\s*auto/);
  });
});
