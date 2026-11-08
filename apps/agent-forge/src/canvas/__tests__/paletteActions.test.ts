import { describe, it, expect } from 'vitest';
import { viewportCentrePosition } from '../paletteActions';
import { nextTabId, tabIds } from '../../components/tabs';

describe('viewportCentrePosition', () => {
  it('centres a node under the middle of an unpanned, unzoomed pane', () => {
    expect(viewportCentrePosition([0, 0, 1], 800, 600)).toEqual({ x: 296, y: 260 });
  });

  it('accounts for pan and zoom', () => {
    // Panned 100px right/50px down at 2x: the pane centre (400, 300) is flow (150, 125).
    expect(viewportCentrePosition([100, 50, 2], 800, 600)).toEqual({ x: 150 - 104, y: 125 - 40 });
  });

  it('survives a zero zoom before the pane has measured', () => {
    expect(viewportCentrePosition([0, 0, 0], 0, 0)).toEqual({ x: -104, y: -40 });
  });
});

describe('tab keyboard model', () => {
  const ids = ['test', 'logs', 'trace'] as const;

  it('moves with the arrow keys, wrapping, and jumps with Home/End', () => {
    expect(nextTabId(ids, 'test', 'ArrowRight')).toBe('logs');
    expect(nextTabId(ids, 'trace', 'ArrowRight')).toBe('test');
    expect(nextTabId(ids, 'test', 'ArrowLeft')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'Home')).toBe('test');
    expect(nextTabId(ids, 'logs', 'End')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'a')).toBeUndefined();
  });

  it('pairs each tab with its panel id', () => {
    expect(tabIds('drawer', 'test')).toEqual({ tab: 'drawer-tab-test', panel: 'drawer-panel-test' });
  });
});
