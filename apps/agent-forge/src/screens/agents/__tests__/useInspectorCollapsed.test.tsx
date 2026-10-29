import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSPECTOR_COLLAPSED_KEY, useInspectorCollapsed } from '../useInspectorCollapsed';
import { breakStorage, installMemoryStorage } from '../../../ui/__tests__/memoryStorage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let latest: { collapsed: boolean; toggle: () => void };

function Probe({ selected }: { selected?: string }) {
  latest = useInspectorCollapsed(selected);
  return null;
}

function render(selected?: string) {
  if (!root) root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Probe, { selected })));
}

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe('useInspectorCollapsed', () => {
  it('is collapsed with nothing selected and opens on selection, without storing anything', () => {
    render();
    expect(latest.collapsed).toBe(true);
    render('llm-1');
    expect(latest.collapsed).toBe(false);
    render(undefined);
    expect(latest.collapsed).toBe(true);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY)).toBeNull();
  });

  it('remembers an explicit Show, so deselecting keeps it open', () => {
    render();
    act(() => latest.toggle());
    expect(latest.collapsed).toBe(false);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY)).toBe('0');
    render('llm-1');
    render(undefined);
    expect(latest.collapsed).toBe(false);
  });

  it('starts open when Show was remembered from an earlier visit', () => {
    window.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, '0');
    render();
    expect(latest.collapsed).toBe(false);
  });

  it('still toggles when storage throws', () => {
    breakStorage();
    render();
    act(() => latest.toggle());
    expect(latest.collapsed).toBe(false);
  });

  it('Hide closes it over a selection until the next selection opens it again', () => {
    render('llm-1');
    act(() => latest.toggle());
    expect(latest.collapsed).toBe(true);
    expect(window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY)).toBe('1');
    render('tool-2');
    expect(latest.collapsed).toBe(false);
  });
});

describe('useInspectorCollapsed after a Hide', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it('reopens when the same node is selected again after the selection moved on', () => {
    render('llm-1');
    act(() => latest.toggle());
    expect(latest.collapsed).toBe(true);
    render(undefined);
    render('llm-1');
    expect(latest.collapsed).toBe(false);
  });

  it('opens on the very render that selects a node (no effect step)', () => {
    const seen: boolean[] = [];
    function Recorder({ selected }: { selected?: string }) {
      seen.push(useInspectorCollapsed(selected).collapsed);
      return null;
    }
    const r = createRoot(document.createElement('div'));
    act(() => r.render(createElement(Recorder, {})));
    seen.length = 0;
    act(() => r.render(createElement(Recorder, { selected: 'llm-1' })));
    expect(seen.every((c) => c === false)).toBe(true);
    act(() => r.unmount());
  });
});
