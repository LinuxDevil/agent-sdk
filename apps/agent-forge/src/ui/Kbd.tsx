import './menu.css';
import { Fragment } from 'react';

/**
 * 'Mod' renders as ⌘ on Apple platforms and Ctrl elsewhere. `platform` defaults
 * to `navigator.platform` (deprecated but present in jsdom and all target
 * browsers); callers pass it explicitly in tests.
 */
export function modKeyLabel(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): '⌘' | 'Ctrl' {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}

/**
 * Keyboard shortcut chip: `combo="Mod+J"` draws `Ctrl + J` / `⌘J`, `combo="Esc"` a
 * lone key. A `+` joins parts unless it would follow ⌘ (Apple style writes the
 * glyph chord without it). Styled by menu.css's `.kbd-*` rules so Menu items
 * and standalone hints share one look.
 */
export function Kbd({ combo }: { combo: string }): JSX.Element {
  const parts = combo
    .split('+')
    .filter((part) => part.length > 0)
    .map((part) => (part === 'Mod' ? modKeyLabel() : part));
  return (
    <span className="kbd-combo">
      {parts.map((label, i) => (
        <Fragment key={i}>
          {i > 0 && parts[i - 1] !== '⌘' ? (
            <span className="kbd-plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <kbd>{label}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
