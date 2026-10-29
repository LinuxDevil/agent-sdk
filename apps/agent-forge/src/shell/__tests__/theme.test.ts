import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  THEME_EVENT,
  applyStoredDensity,
  applyStoredTheme,
  getDensity,
  getThemeChoice,
  setDensity,
  setThemeChoice,
  toggleTheme,
} from '../theme';

const root = document.documentElement;

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  root.removeAttribute('data-theme');
  root.removeAttribute('data-density');
  window.localStorage.clear();
});

describe('theme choice', () => {
  it('reads "system" when nothing is forced', () => {
    expect(getThemeChoice()).toBe('system');
  });

  it('forces light or dark on <html> and remembers it', () => {
    setThemeChoice('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('forge.theme')).toBe('dark');
    expect(getThemeChoice()).toBe('dark');
    setThemeChoice('light');
    expect(getThemeChoice()).toBe('light');
  });

  it('"system" removes both the attribute and the stored key', () => {
    setThemeChoice('dark');
    setThemeChoice('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('forge.theme')).toBeNull();
    expect(getThemeChoice()).toBe('system');
  });

  it('announces every change, the palette toggle included', () => {
    const seen = vi.fn();
    window.addEventListener(THEME_EVENT, seen);
    setThemeChoice('dark');
    toggleTheme();
    window.removeEventListener(THEME_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(getThemeChoice()).toBe('light');
    expect(window.localStorage.getItem('forge.theme')).toBe('light');
  });

  it('applyStoredTheme re-applies a remembered choice and ignores garbage', () => {
    window.localStorage.setItem('forge.theme', 'dark');
    applyStoredTheme();
    expect(getThemeChoice()).toBe('dark');
    root.removeAttribute('data-theme');
    window.localStorage.setItem('forge.theme', 'sepia');
    applyStoredTheme();
    expect(getThemeChoice()).toBe('system');
  });
});

describe('table density', () => {
  it('is unset by default, so each table keeps its own density', () => {
    expect(getDensity()).toBeNull();
  });

  it('sets <html data-density> and remembers it; null clears both', () => {
    setDensity('comfortable');
    expect(root.getAttribute('data-density')).toBe('comfortable');
    expect(window.localStorage.getItem('forge.density')).toBe('comfortable');
    expect(getDensity()).toBe('comfortable');
    setDensity(null);
    expect(root.hasAttribute('data-density')).toBe(false);
    expect(window.localStorage.getItem('forge.density')).toBeNull();
  });

  it('applyStoredDensity re-applies a remembered density and ignores garbage', () => {
    window.localStorage.setItem('forge.density', 'compact');
    applyStoredDensity();
    expect(getDensity()).toBe('compact');
    root.removeAttribute('data-density');
    window.localStorage.setItem('forge.density', 'roomy');
    applyStoredDensity();
    expect(getDensity()).toBeNull();
  });
});
