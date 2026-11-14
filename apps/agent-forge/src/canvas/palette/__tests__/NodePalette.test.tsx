import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import { installMemoryStorage } from '../../../ui/__tests__/memoryStorage';
import type { Graph } from '../../../graph/v2/types';

const ROOT_AGENT = {
  id: 'agent',
  kind: 'agent' as const,
  owner: null,
  position: { x: 0, y: 0 },
  data: { fields: { name: 'Root' }, extra: {} },
};

const appState = vi.hoisted(() => ({
  graph: { version: 2, nodes: [], emptySections: [], unplaced: [] } as unknown as Graph,
  setGraph: vi.fn(),
  selectedNodeId: undefined as string | undefined,
  setSelectedNodeId: vi.fn(),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { ReactFlowProvider } from '@xyflow/react';
import { NodePalette } from '../NodePalette';

function mount() {
  return render(
    <ReactFlowProvider>
      <NodePalette />
    </ReactFlowProvider>,
  );
}

function paletteItems(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.node-palette-item')];
}

function itemByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  return paletteItems(container).find((el) => el.getAttribute('aria-label') === label)!;
}

/** Sets an input's value the way a user typing does (React tracks the native setter). */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function searchInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="search"]')!;
}

describe('NodePalette', () => {
  beforeEach(() => {
    installMemoryStorage();
    appState.graph = { version: 2, nodes: [ROOT_AGENT], emptySections: [], unplaced: [] } as unknown as Graph;
    appState.selectedNodeId = undefined;
    appState.setGraph.mockClear();
    appState.setSelectedNodeId.mockClear();
  });

  it('renders grouped sections with counts and a search box', () => {
    const container = mount();
    const heads = [...container.querySelectorAll('.palette-group-head')];
    expect(heads.length).toBeGreaterThan(0);
    expect(heads[0].getAttribute('aria-expanded')).toBe('true');
    expect(heads[0].querySelector('.palette-group-name')?.textContent).toBe('Start');
    expect(heads[0].querySelector('.palette-count')?.classList.contains('tabular-nums')).toBe(true);
    const input = searchInput(container);
    expect(input.getAttribute('aria-label')).toBe('Search nodes');
    expect(input.placeholder).toBe('Search nodes');
  });

  it('filters on search, expands matching groups and offers a clear button on no match', () => {
    const container = mount();
    // Collapse Safety first: a search must expand it again while active.
    const safetyHead = [...container.querySelectorAll<HTMLButtonElement>('.palette-group-head')].find(
      (h) => h.querySelector('.palette-group-name')?.textContent === 'Safety',
    )!;
    act(() => safetyHead.click());
    expect(itemByLabel(container, 'Permission rule')).toBeUndefined();

    typeInto(searchInput(container), 'appr');
    const items = paletteItems(container);
    expect(items.map((el) => el.getAttribute('aria-label'))).toEqual(['Permission rule', 'Ask for approval']);
    expect(safetyHead.getAttribute('aria-expanded')).toBe('true');

    typeInto(searchInput(container), 'zzz-no-match');
    expect(container.querySelector('.palette-empty')?.textContent).toContain("No nodes match 'zzz-no-match'.");
    const clear = [...container.querySelectorAll<HTMLButtonElement>('.palette-empty button')].find(
      (b) => b.textContent === 'Clear search',
    )!;
    act(() => clear.click());
    expect(searchInput(container).value).toBe('');
    expect(paletteItems(container).length).toBeGreaterThan(1);
  });

  it('persists collapsed groups in localStorage across mounts', () => {
    const first = mount();
    const head = [...first.querySelectorAll<HTMLButtonElement>('.palette-group-head')].find(
      (h) => h.querySelector('.palette-group-name')?.textContent === 'Safety',
    )!;
    act(() => head.click());
    expect(JSON.parse(window.localStorage.getItem('forge.palette.collapsed')!)).toContain('Safety');
    expect(paletteItems(first).some((el) => el.getAttribute('aria-label') === 'Permission rule')).toBe(false);

    const second = mount();
    const secondHead = [...second.querySelectorAll<HTMLButtonElement>('.palette-group-head')].find(
      (h) => h.querySelector('.palette-group-name')?.textContent === 'Safety',
    )!;
    expect(secondHead.getAttribute('aria-expanded')).toBe('false');
    expect(paletteItems(second).some((el) => el.getAttribute('aria-label') === 'Permission rule')).toBe(false);
  });

  it('Enter on an item adds the node through setGraph and selects it', () => {
    const container = mount();
    const item = itemByLabel(container, 'Permission rule');
    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const updater = appState.setGraph.mock.calls[0][0] as (g: Graph) => Graph;
    const next = updater(appState.graph);
    const added = next.nodes[next.nodes.length - 1];
    expect(added.kind).toBe('permission');
    expect(added.owner).toBe('agent');
    expect(appState.setSelectedNodeId).toHaveBeenCalledWith(added.id);
    expect(container.querySelector('.palette-notice')?.textContent).toBe('Added Permission rule to Root.');
  });

  it('shows an unavailable reason as aria-disabled tooltip and status notice on activation', () => {
    appState.graph = {
      version: 2,
      emptySections: [],
      unplaced: [],
      nodes: [
        ROOT_AGENT,
        {
          id: 'output',
          kind: 'output',
          owner: 'agent',
          position: { x: 0, y: 0 },
          data: { item: { jsonSchema: { type: 'object' } } },
        },
      ],
    } as unknown as Graph;
    const container = mount();
    const item = itemByLabel(container, 'Output schema');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.draggable).toBe(false);
    expect(item.title).toBe('This agent already has an output schema');
    act(() => item.click());
    expect(container.querySelector('.palette-notice')?.textContent).toBe('This agent already has an output schema');
    expect(appState.setGraph).not.toHaveBeenCalled();
  });

  it('drags the entry id under the shared palette MIME type', () => {
    const container = mount();
    const item = itemByLabel(container, 'Note');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    act(() => item.dispatchEvent(event));
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/agent-forge-node-type', 'note');
  });

  it('ArrowDown/ArrowUp in the search box move focus into the item list', () => {
    const container = mount();
    const input = searchInput(container);
    const first = itemByLabel(container, 'Chat');
    const last = paletteItems(container)[paletteItems(container).length - 1];
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('keeps exactly one tab stop when the first group is collapsed', () => {
    const container = mount();
    const startHead = [...container.querySelectorAll<HTMLButtonElement>('.palette-group-head')].find(
      (h) => h.querySelector('.palette-group-name')?.textContent === 'Start',
    )!;
    act(() => startHead.click());
    const tabbable = [...container.querySelectorAll<HTMLButtonElement>('.node-palette-item')].filter(
      (el) => el.tabIndex === 0,
    );
    expect(tabbable).toHaveLength(1);
    // The tab stop belongs to a rendered (expanded) item, not the collapsed Start group.
    expect(tabbable[0].closest('.palette-group-items')).not.toBeNull();
    expect(tabbable[0].getAttribute('aria-label')).not.toBe('Chat');
  });

  it('/ focuses the search box but not from an editable target', () => {
    const container = mount();
    const input = searchInput(container);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(document.activeElement).toBe(input);

    const outside = document.createElement('input');
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('hints the owning subagent and hides it for the root agent', () => {
    appState.graph = {
      version: 2,
      emptySections: [],
      unplaced: [],
      nodes: [
        ROOT_AGENT,
        {
          id: 'sub:helper',
          kind: 'agent',
          owner: 'agent',
          position: { x: 0, y: 0 },
          data: { fields: { name: 'helper' }, extra: {}, subagentKey: 'helper' },
        },
      ],
    } as unknown as Graph;
    appState.selectedNodeId = 'sub:helper';
    const container = mount();
    expect(container.querySelector('.palette-owner')?.textContent).toBe('Adding to: helper');
  });
});
