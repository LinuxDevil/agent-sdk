import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ToolCatalogPicker } from '../tool/ToolCatalogPicker';
import type { CatalogState } from '../../useCatalog';
import type { CatalogTool } from '../../../../shared/wireTypes';

const catalog = vi.hoisted(() => {
  const tool = (over: Partial<CatalogTool>): CatalogTool => ({
    name: 'tool',
    description: 'Does a thing',
    inputJsonSchema: {},
    needsCredentials: [],
    mutating: false,
    optionsJsonSchema: null,
    toolNames: ['tool'],
    ...over,
  });
  const TOOLS: CatalogTool[] = [
    tool({ name: 'web_fetch', description: 'Fetches a URL' }),
    tool({ name: 'http_request', description: 'Calls an HTTP endpoint', mutating: true }),
    tool({ name: 'shell', description: 'Runs a command', mutating: true, needsCredentials: ['SHELL_KEY'] }),
    tool({ name: 'todo', description: 'Plan list' }),
  ];
  return {
    TOOLS,
    state: { data: TOOLS, error: undefined, loading: false } as CatalogState<CatalogTool[]>,
    refresh: vi.fn(),
  };
});

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: catalog.refresh,
}));

let container: HTMLDivElement;
const onChange = vi.fn();

function render(value = '') {
  container = mount(<ToolCatalogPicker id="node-tool-builtin" value={value} onChange={onChange} />);
}

const options = () => [...container.querySelectorAll('[role="option"]')] as HTMLElement[];
const search = () => container.querySelector('input[aria-label="Search tools"]') as HTMLInputElement;

function typeIn(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: HTMLElement, keyName: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

beforeEach(() => {
  onChange.mockReset();
  catalog.state = { data: catalog.TOOLS, error: undefined, loading: false };
});

describe('ToolCatalogPicker', () => {
  it('lists every catalog tool with its description', () => {
    render();
    expect(options().map((o) => o.querySelector('.tool-option-name')?.textContent)).toEqual([
      'web_fetch',
      'http_request',
      'shell',
      'todo',
    ]);
    expect(container.textContent).toContain('Fetches a URL');
  });

  it('filters options by the search input', () => {
    render();
    typeIn(search(), 'http');
    expect(options().map((o) => o.querySelector('.tool-option-name')?.textContent)).toEqual([
      'http_request',
    ]);
  });

  it('marks the picked option aria-selected and emits on click', () => {
    render('web_fetch');
    const picked = options()[0];
    expect(picked.getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    act(() => options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('http_request');
  });

  it('moves the active row with Up/Down and picks it with Enter', () => {
    render();
    key(search(), 'ArrowDown');
    key(search(), 'ArrowDown');
    key(search(), 'ArrowUp');
    key(search(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('http_request');
  });

  it('shows the mutating and credential chips', () => {
    render();
    const http = options()[1];
    expect(http.textContent).toContain('edits data');
    const shell = options()[2];
    expect(shell.textContent).toContain('edits data');
    expect(shell.textContent).toContain('needs SHELL_KEY');
  });

  it('shows the picked tool description as the hint', () => {
    render('web_fetch');
    expect(container.textContent).toContain('Fetches a URL');
  });

  it('warns when the value is not in the catalog', () => {
    render('local_tool');
    expect(container.textContent).toContain(
      'Not in the catalog. The run will fail unless a local tool has this name.'
    );
  });

  it('marks an empty value required', () => {
    render('');
    expect(container.textContent).toContain('Pick a tool');
  });

  it('shows skeleton rows while the catalog loads', () => {
    catalog.state = { data: undefined, error: undefined, loading: true };
    render();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[aria-label="Search tools"]')).toBeNull();
    expect(container.querySelector('.skeleton-rows')).not.toBeNull();
  });

  it('shows the error and a Retry button that refreshes the catalog', () => {
    catalog.state = { data: undefined, error: 'offline', loading: false };
    render();
    expect(container.textContent).toContain('offline');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(catalog.refresh).toHaveBeenCalledWith('tools');
  });
});
