import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../ui/__tests__/render';

import { refreshCatalog, useCatalog, type CatalogKind, type CatalogPayloads, type CatalogState } from '../useCatalog';
import { runtimeClient } from '../../runtime/runtimeClient';
import type { CatalogModel, CatalogTool } from '../../../shared/wireTypes';

const MODELS: CatalogModel[] = [
  {
    id: 'openai/gpt-4o-mini',
    modelId: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128_000,
    capabilities: { tools: true, vision: true, reasoning: false, structuredOutput: true, hostedTools: [] },
    available: true,
  },
];

const KINDS: CatalogKind[] = ['models', 'tools', 'guardrails', 'triggers', 'skills', 'kits'];

afterEach(() => {
  for (const kind of KINDS) refreshCatalog(kind);
  vi.restoreAllMocks();
});

let container: HTMLDivElement;

/** Renders the hook's state as text so the DOM tells us which phase it is in. */
function Probe(): JSX.Element {
  const state: CatalogState<CatalogPayloads['models']> = useCatalog('models');
  return <div className="probe">{state.loading ? 'loading' : (state.error ?? `data:${state.data?.length}`)}</div>;
}

function ToolProbe(): JSX.Element {
  const state: CatalogState<CatalogPayloads['tools']> = useCatalog('tools');
  return <div className="probe">{state.loading ? 'loading' : (state.error ?? `data:${state.data?.length}`)}</div>;
}

const flush = () => act(async () => {});

describe('useCatalog', () => {
  it('fetches a kind once per page load and shares the payload across callers', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogModels').mockResolvedValue(MODELS);
    container = render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    const probes = [...container.querySelectorAll('.probe')];
    expect(probes.map((p) => p.textContent)).toEqual(['data:1', 'data:1']);
  });

  it('starts in the loading state until the request settles', async () => {
    let resolve!: (value: CatalogModel[]) => void;
    vi.spyOn(runtimeClient, 'catalogModels').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    container = render(<Probe />);
    expect(container.querySelector('.probe')!.textContent).toBe('loading');
    await act(async () => resolve(MODELS));
    expect(container.querySelector('.probe')!.textContent).toBe('data:1');
  });

  it('surfaces a failed request as an error message, not a throw', async () => {
    vi.spyOn(runtimeClient, 'catalogModels').mockRejectedValue(new Error('offline'));
    container = render(<Probe />);
    await flush();
    expect(container.querySelector('.probe')!.textContent).toBe('offline');
  });

  it('keeps the failure cached so a remount shows the same error without refetching', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogModels').mockRejectedValue(new Error('offline'));
    container = render(<Probe />);
    await flush();
    container = render(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.probe')!.textContent).toBe('offline');
  });

  it('refetches a mounted hook when refreshCatalog runs (the Retry path)', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogModels').mockRejectedValue(new Error('offline'));
    container = render(<Probe />);
    await flush();
    expect(container.querySelector('.probe')!.textContent).toBe('offline');

    spy.mockResolvedValue(MODELS);
    act(() => refreshCatalog('models'));
    expect(container.querySelector('.probe')!.textContent).toBe('loading');
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.probe')!.textContent).toBe('data:1');
  });

  it('refetches on the next mount after refreshCatalog', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogModels').mockResolvedValue(MODELS);
    container = render(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);

    refreshCatalog('models');
    container = render(<Probe />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.probe')!.textContent).toBe('data:1');
  });

  it('caches each kind separately', async () => {
    const models = vi.spyOn(runtimeClient, 'catalogModels').mockResolvedValue(MODELS);
    const tools = vi.spyOn(runtimeClient, 'catalogTools').mockResolvedValue([
      {
        name: 'http_request',
        description: 'd',
        inputJsonSchema: {},
        needsCredentials: [],
        mutating: true,
        optionsJsonSchema: null,
        toolNames: ['http_request'],
      },
    ] satisfies CatalogTool[]);
    container = render(
      <>
        <Probe />
        <ToolProbe />
      </>,
    );
    await flush();
    expect(models).toHaveBeenCalledTimes(1);
    expect(tools).toHaveBeenCalledTimes(1);
    const probes = [...container.querySelectorAll('.probe')];
    expect(probes.map((p) => p.textContent)).toEqual(['data:1', 'data:1']);
  });
});
