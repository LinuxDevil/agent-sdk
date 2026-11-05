import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ModelPicker } from '../agent/ModelPicker';
import type { CatalogState } from '../../useCatalog';
import type { CatalogModel } from '../../../../shared/wireTypes';

const catalog = vi.hoisted(() => {
  const MODELS: CatalogModel[] = [
    {
      id: 'openai/gpt-5',
      modelId: 'gpt-5',
      provider: 'openai',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: true,
    },
    {
      id: 'anthropic/claude-sonnet-5-5',
      modelId: 'claude-sonnet-5-5',
      provider: 'anthropic',
      contextWindow: 200_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: false,
    },
  ];
  return {
    MODELS,
    state: { data: MODELS, error: undefined, loading: false } as CatalogState<CatalogModel[]>,
    refresh: vi.fn(),
  };
});

const MODELS = catalog.MODELS;

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: catalog.refresh,
}));

let container: HTMLDivElement;

function render(props: { value?: string; onChange?: (value: string | undefined) => void } = {}) {
  container = mount(<ModelPicker id="node-agent-model" value={props.value} onChange={props.onChange ?? vi.fn()} />);
}

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const select = () => container.querySelector('select') as HTMLSelectElement;
const input = () => container.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  catalog.state = { data: MODELS, error: undefined, loading: false };
});

describe('ModelPicker', () => {
  it('groups catalog models by provider, alphabetically', () => {
    render({ value: 'openai/gpt-5' });
    const groups = [...container.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['anthropic', 'openai']);
    const options = [...select().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual([
      'Pick a model',
      'anthropic/claude-sonnet-5-5 (no key)',
      'openai/gpt-5',
      'Other…',
    ]);
    expect(select().value).toBe('openai/gpt-5');
  });

  it('emits the picked provider/model', () => {
    const onChange = vi.fn();
    render({ value: '', onChange });
    choose(select(), 'anthropic/claude-sonnet-5-5');
    expect(onChange).toHaveBeenLastCalledWith('anthropic/claude-sonnet-5-5');
  });

  it('"Other…" switches to a free-text input that accepts any provider/model', () => {
    const onChange = vi.fn();
    render({ value: 'openai/gpt-5', onChange });
    choose(select(), '__other__');
    expect(input()).not.toBeNull();
    type(input(), 'custom/my-model');
    expect(onChange).toHaveBeenLastCalledWith('custom/my-model');
  });

  it('shows a free-text input plus the hint when the value is not in the catalog', () => {
    render({ value: 'custom/my-model' });
    expect(select()).toBeNull();
    expect(input().value).toBe('custom/my-model');
    expect(container.textContent).toContain('Not in the catalog. It will still be tried.');
  });

  it('shows an invalid model id error for a malformed free-text value', () => {
    render({ value: 'noslash' });
    expect(container.textContent).toContain('Use provider/model, e.g. anthropic/claude-sonnet-5-5');
  });

  it('marks an empty value as required', () => {
    render({ value: '' });
    expect(container.textContent).toContain('Required');
  });

  it('renders a disabled loading select while the catalog loads', () => {
    catalog.state = { data: undefined, error: undefined, loading: true };
    render();
    expect(select().disabled).toBe(true);
    expect(select().textContent).toContain('Loading models…');
  });

  it('renders a free-text input and a Retry button on catalog error', () => {
    catalog.state = { data: undefined, error: 'offline', loading: false };
    render({ value: 'openai/gpt-5' });
    expect(input()).not.toBeNull();
    expect(container.textContent).toContain('offline');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(catalog.refresh).toHaveBeenCalledWith('models');
  });
});
