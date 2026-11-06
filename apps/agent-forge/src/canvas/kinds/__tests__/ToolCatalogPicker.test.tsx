import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ToolCatalogPicker } from '../tool/ToolCatalogPicker';
import { refreshCatalog } from '../../useCatalog';
import { runtimeClient } from '../../../runtime/runtimeClient';
import type { CatalogTool } from '../../../../shared/wireTypes';

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

const flush = () => act(async () => {});

let container: HTMLDivElement;
const onChange = vi.fn();

async function render(value = '') {
  container = mount(<ToolCatalogPicker id="node-tool-builtin" value={value} onChange={onChange} />);
  await flush();
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
  vi.spyOn(runtimeClient, 'catalogTools').mockResolvedValue(TOOLS);
});

afterEach(() => {
  refreshCatalog('tools');
  vi.restoreAllMocks();
});

describe('ToolCatalogPicker', () => {
  it('lists every catalog tool with its description', async () => {
    await render();
    expect(options().map((o) => o.querySelector('.tool-option-name')?.textContent)).toEqual([
      'web_fetch',
      'http_request',
      'shell',
      'todo',
    ]);
    expect(container.textContent).toContain('Fetches a URL');
  });

  it('filters options by the search input', async () => {
    await render();
    typeIn(search(), 'http');
    expect(options().map((o) => o.querySelector('.tool-option-name')?.textContent)).toEqual([
      'http_request',
    ]);
  });

  it('marks the picked option aria-selected and emits on click', async () => {
    await render('web_fetch');
    const picked = options()[0];
    expect(picked.getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    act(() => options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('http_request');
  });

  it('moves the active row with Up/Down and picks it with Enter', async () => {
    await render();
    key(search(), 'ArrowDown');
    key(search(), 'ArrowDown');
    key(search(), 'ArrowUp');
    key(search(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('http_request');
  });

  it('shows the mutating and credential chips', async () => {
    await render();
    const http = options()[1];
    expect(http.textContent).toContain('edits data');
    const shell = options()[2];
    expect(shell.textContent).toContain('edits data');
    expect(shell.textContent).toContain('needs SHELL_KEY');
  });

  it('shows the picked tool description as the hint', async () => {
    await render('web_fetch');
    expect(container.textContent).toContain('Fetches a URL');
  });

  it('warns when the value is not in the catalog', async () => {
    await render('local_tool');
    expect(container.textContent).toContain(
      'Not in the catalog. The run will fail unless a local tool has this name.'
    );
  });

  it('marks an empty value required', async () => {
    await render('');
    expect(container.textContent).toContain('Pick a tool');
  });

  it('shows skeleton rows while the catalog loads', () => {
    vi.spyOn(runtimeClient, 'catalogTools').mockImplementation(() => new Promise(() => {}));
    container = mount(<ToolCatalogPicker id="node-tool-builtin" value="" onChange={onChange} />);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[aria-label="Search tools"]')).toBeNull();
    expect(container.querySelector('.skeleton-rows')).not.toBeNull();
  });

  it('shows the error and a Retry button that refetches the mounted catalog', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogTools').mockRejectedValue(new Error('offline'));
    await render();
    expect(container.textContent).toContain('offline');
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    spy.mockResolvedValue(TOOLS);
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(options().length).toBe(TOOLS.length);
    expect(container.textContent).not.toContain('offline');
  });
});
