import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  DRAWER_DEFAULT_HEIGHT,
  DRAWER_HEIGHT_KEY,
  DRAWER_MAX_HEIGHT,
  DRAWER_MIN_HEIGHT,
  DrawerResizeHandle,
  useDrawerHeight,
} from '../drawerHeight';

function Harness() {
  const { height, setHeight } = useDrawerHeight();
  return (
    <div data-height={height}>
      <DrawerResizeHandle height={height} onResize={setHeight} />
    </div>
  );
}

const height = (container: HTMLElement) => Number((container.firstElementChild as HTMLElement).dataset.height);
const handle = (container: HTMLElement) => container.querySelector('[role="separator"]') as HTMLElement;
const key = (el: HTMLElement, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('drawer height', () => {
  it('defaults when nothing (or garbage) is stored', () => {
    expect(height(render(<Harness />))).toBe(DRAWER_DEFAULT_HEIGHT);
    window.localStorage.setItem(DRAWER_HEIGHT_KEY, 'tall');
    expect(height(render(<Harness />))).toBe(DRAWER_DEFAULT_HEIGHT);
  });

  it('restores the stored height, clamped to the min/max', () => {
    window.localStorage.setItem(DRAWER_HEIGHT_KEY, '360');
    expect(height(render(<Harness />))).toBe(360);
    window.localStorage.setItem(DRAWER_HEIGHT_KEY, '5000');
    expect(height(render(<Harness />))).toBe(DRAWER_MAX_HEIGHT);
    window.localStorage.setItem(DRAWER_HEIGHT_KEY, '10');
    expect(height(render(<Harness />))).toBe(DRAWER_MIN_HEIGHT);
  });

  it('resizes from the keyboard and remembers the new height', () => {
    const container = render(<Harness />);
    const separator = handle(container);
    expect(separator.getAttribute('aria-valuenow')).toBe(String(DRAWER_DEFAULT_HEIGHT));
    expect(separator.getAttribute('aria-valuemin')).toBe(String(DRAWER_MIN_HEIGHT));
    expect(separator.getAttribute('aria-valuemax')).toBe(String(DRAWER_MAX_HEIGHT));
    key(separator, 'ArrowUp');
    expect(height(container)).toBeGreaterThan(DRAWER_DEFAULT_HEIGHT);
    expect(window.localStorage.getItem(DRAWER_HEIGHT_KEY)).toBe(String(height(container)));
    key(separator, 'Home');
    expect(height(container)).toBe(DRAWER_MIN_HEIGHT);
    key(separator, 'End');
    expect(height(container)).toBe(DRAWER_MAX_HEIGHT);
    expect(window.localStorage.getItem(DRAWER_HEIGHT_KEY)).toBe(String(DRAWER_MAX_HEIGHT));
  });

  it('works when storage throws', () => {
    breakStorage();
    const container = render(<Harness />);
    expect(height(container)).toBe(DRAWER_DEFAULT_HEIGHT);
    key(handle(container), 'ArrowDown');
    expect(height(container)).toBeLessThan(DRAWER_DEFAULT_HEIGHT);
  });
});
