import { beforeEach, describe, expect, it } from 'vitest';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_VIEWPORT_FRACTION,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_OPEN_KEY,
  DOCK_WIDTH_KEY,
  clampDockWidth,
  dockMaxWidth,
  readDockOpen,
  readDockWidth,
} from '../dockState';

beforeEach(() => {
  installMemoryStorage();
});

describe('clampDockWidth', () => {
  it('clamps to the 360px floor, the 640px ceiling and 45vw, and rounds', () => {
    expect(clampDockWidth(100, 1600)).toBe(DOCK_MIN_WIDTH); // 360
    expect(clampDockWidth(9999, 1600)).toBe(DOCK_MAX_WIDTH); // 640
    expect(clampDockWidth(9999, 1000)).toBe(450);
    expect(clampDockWidth(500.6, 1600)).toBe(501);
    expect(clampDockWidth(NaN, 1600)).toBe(DOCK_DEFAULT_WIDTH); // 490
  });
});

describe('dockMaxWidth', () => {
  it('is min(640, floor(45% of vw)) and never below 360', () => {
    expect(dockMaxWidth(700)).toBe(DOCK_MIN_WIDTH); // 360 even though 45vw is less
    expect(dockMaxWidth(2000)).toBe(DOCK_MAX_WIDTH);
    expect(dockMaxWidth(1000)).toBe(Math.floor(1000 * DOCK_MAX_VIEWPORT_FRACTION)); // 450
  });
});

describe('readDockWidth', () => {
  it('returns the stored width clamped to the viewport', () => {
    window.localStorage.setItem(DOCK_WIDTH_KEY, '9999');
    expect(readDockWidth(1600)).toBe(DOCK_MAX_WIDTH);
  });

  it('falls back to the default on a non-numeric value or broken storage', () => {
    window.localStorage.setItem(DOCK_WIDTH_KEY, 'abc');
    expect(readDockWidth(1600)).toBe(DOCK_DEFAULT_WIDTH);
    breakStorage();
    expect(readDockWidth(1600)).toBe(DOCK_DEFAULT_WIDTH);
  });
});

describe('readDockOpen', () => {
  it('is true only for a stored "1"', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    expect(readDockOpen()).toBe(true);
    window.localStorage.setItem(DOCK_OPEN_KEY, '0');
    expect(readDockOpen()).toBe(false);
  });

  it('is false when nothing is stored or storage throws', () => {
    expect(readDockOpen()).toBe(false);
    breakStorage();
    expect(readDockOpen()).toBe(false);
  });
});
