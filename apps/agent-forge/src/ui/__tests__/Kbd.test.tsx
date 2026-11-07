import { afterEach, describe, expect, it } from 'vitest';
import { render } from './render';
import { Kbd, modKeyLabel } from '../Kbd';

/** navigator.platform is a data property, so stub it with defineProperty and put it back after. */
const originalPlatform = window.navigator.platform;
function setPlatform(value: string) {
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true });
}
afterEach(() => setPlatform(originalPlatform));

describe('modKeyLabel', () => {
  it('maps Apple platforms to ⌘ and everything else to Ctrl', () => {
    expect(modKeyLabel('MacIntel')).toBe('⌘');
    expect(modKeyLabel('Win32')).toBe('Ctrl');
  });
});

describe('Kbd', () => {
  it('renders Mod+J as Ctrl + J off Apple platforms', () => {
    setPlatform('Win32');
    const host = render(<Kbd combo="Mod+J" />);
    expect(host.querySelector('.kbd-combo')).not.toBeNull();
    expect([...host.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'J']);
    expect(host.querySelectorAll('.kbd-plus')).toHaveLength(1);
  });

  it('renders Mod+J as ⌘J on Apple platforms, with no plus', () => {
    setPlatform('MacIntel');
    const host = render(<Kbd combo="Mod+J" />);
    expect([...host.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'J']);
    expect(host.querySelectorAll('.kbd-plus')).toHaveLength(0);
  });

  it('renders a lone key without a plus', () => {
    const host = render(<Kbd combo="Esc" />);
    expect([...host.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Esc']);
    expect(host.querySelectorAll('.kbd-plus')).toHaveLength(0);
  });
});
