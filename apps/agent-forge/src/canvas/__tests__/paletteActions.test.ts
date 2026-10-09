import { describe, it, expect } from 'vitest';
import { pickHookTemplate, viewportCentrePosition } from '../paletteActions';
import { nextTabId, tabIds } from '../../components/tabs';

describe('viewportCentrePosition (Eve DUI-F9)', () => {
  it('centres a node under the middle of an unpanned, unzoomed pane', () => {
    expect(viewportCentrePosition([0, 0, 1], 800, 600)).toEqual({ x: 305, y: 260 });
  });

  it('accounts for pan and zoom', () => {
    // Panned 100px right/50px down at 2x: the pane centre (400, 300) is flow (150, 125).
    expect(viewportCentrePosition([100, 50, 2], 800, 600)).toEqual({ x: 150 - 95, y: 125 - 40 });
  });

  it('survives a zero zoom before the pane has measured', () => {
    expect(viewportCentrePosition([0, 0, 0], 0, 0)).toEqual({ x: -95, y: -40 });
  });
});

describe('pickHookTemplate', () => {
  it('matches the node hook point and the palette phase', () => {
    const llmPost = pickHookTemplate('llm', 'post');
    expect(llmPost.point).toBe('generate');
    const toolPre = pickHookTemplate('tool', 'pre');
    expect(toolPre.point).toBe('toolCall');
  });
});

describe('tab keyboard model (Eve DUI-F9)', () => {
  const ids = ['chat', 'logs', 'trace'] as const;

  it('moves with the arrow keys, wrapping, and jumps with Home/End', () => {
    expect(nextTabId(ids, 'chat', 'ArrowRight')).toBe('logs');
    expect(nextTabId(ids, 'trace', 'ArrowRight')).toBe('chat');
    expect(nextTabId(ids, 'chat', 'ArrowLeft')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'Home')).toBe('chat');
    expect(nextTabId(ids, 'logs', 'End')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'a')).toBeUndefined();
  });

  it('pairs each tab with its panel id', () => {
    expect(tabIds('drawer', 'chat')).toEqual({ tab: 'drawer-tab-chat', panel: 'drawer-panel-chat' });
  });
});
