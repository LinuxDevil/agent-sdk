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

describe('U01 tokens', () => {
  const theme = sheet('theme.css');
  it.each(['success', 'warning', 'danger', 'info'])('--%s-border is the status colour at 40%%', (s) => {
    expect(theme).toMatch(new RegExp(`--${s}-border:\\s*color-mix\\(in srgb, var\\(--${s}\\) 40%, transparent\\);`));
  });
  it('adds --fs-display 22px and --dock-width 490px', () => {
    expect(theme).toMatch(/--fs-display:\s*22px;/);
    expect(theme).toMatch(/--dock-width:\s*490px;/);
  });
  it('--nav-bg is a light-dark pair', () => {
    expect(theme).toMatch(/--nav-bg:\s*light-dark\(#efeff2,\s*#060608\);/);
  });
});

describe('A12 builder tab strip', () => {
  it('.app.app-builder-tabs adds the 40px strip row above the 52px toolbar', () => {
    expect(rulesFor(sheet('components/layout.css'), '.app.app-builder-tabs')).toMatch(
      /grid-template-rows:\s*40px 52px minmax\(0, 1fr\) auto/,
    );
  });

  it('.builder-tabs aligns its tabs to the bottom edge over a surface background', () => {
    const rules = rulesFor(sheet('screens/agents/builderTabs.css'), '.builder-tabs');
    expect(rules).toMatch(/align-items:\s*flex-end/);
    expect(rules).toMatch(/background:\s*var\(--surface\)/);
    expect(rules).toMatch(/border-bottom:\s*1px solid var\(--border\)/);
  });
});

describe('U02 floating content card', () => {
  const css = sheet('shell/shell.css');
  it('frames the shell on --nav-bg', () => {
    expect(rulesFor(css, '.app-shell')).toMatch(/background:\s*var\(--nav-bg\)/);
    expect(rulesFor(css, '.nav-rail')).toMatch(/background:\s*var\(--nav-bg\)/);
  });
  it('floats the screen as a card when docked', () => {
    const main = rulesFor(css, '.app-shell-main');
    expect(main).toMatch(/margin:\s*var\(--space-2\) var\(--space-2\) var\(--space-2\) 0/);
    expect(main).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(main).toMatch(/box-shadow:\s*var\(--shadow-sm\)/);
    expect(main).toMatch(/overflow:\s*hidden/);
  });
  it('drops the card below 860px', () => {
    const narrow = rulesFor(css, '.app-shell-narrow .app-shell-main');
    expect(narrow).toMatch(/margin:\s*0/);
    expect(narrow).toMatch(/border-radius:\s*0/);
    expect(narrow).toMatch(/box-shadow:\s*none/);
  });
});
