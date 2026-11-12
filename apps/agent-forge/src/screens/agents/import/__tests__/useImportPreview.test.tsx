/**
 * useImportPreview (L08b): the 400 ms debounce, the request counter that
 * drops stale answers, the empty-text short-circuit and the error mapping.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  previewImport: vi.fn(),
}));
vi.mock('../../../../runtime/runtimeClient', () => ({
  runtimeClient: api,
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string
    ) {
      super(message);
    }
  },
}));

import type { ImportPreview } from '../../../../../shared/wireTypes';
import { render, rerender } from '../../../../ui/__tests__/render';
import { useImportPreview } from '../useImportPreview';

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    format: 'yaml',
    spec: { version: 2, name: 'Support triage', model: 'anthropic/claude-sonnet-5-5' } as unknown as ImportPreview['spec'],
    labels: [],
    suggestedId: 'support-triage',
    clash: null,
    resolvedId: 'support-triage',
    requirements: [],
    prompts: [],
    warnings: [],
    ...over,
  };
}

function Probe({ text, mode = 'new', targetId }: { text: string; mode?: 'new' | 'replace' | 'copy'; targetId?: string }) {
  const state = useImportPreview(text, mode, targetId);
  return (
    <output
      data-loading={String(state.loading)}
      data-name={state.preview?.spec.name ?? ''}
      data-error={state.error?.message ?? ''}
      data-code={state.error?.code ?? ''}
    />
  );
}

const out = (host: HTMLElement) => host.querySelector('output')!;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useImportPreview', () => {
  it('sends nothing for empty or whitespace text', async () => {
    const host = render(<Probe text="   " />);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.previewImport).not.toHaveBeenCalled();
    expect(out(host).dataset.loading).toBe('false');
  });

  it('debounces: fast typing sends one request 400 ms after the last change', async () => {
    api.previewImport.mockResolvedValue(preview());
    const host = render(<Probe text="n" />);
    await act(async () => vi.advanceTimersByTime(200));
    // Rerender with more text before the timer fires.
    rerender(<Probe text="na" />);
    await act(async () => vi.advanceTimersByTime(200));
    rerender(<Probe text="nam" />);
    await act(async () => vi.advanceTimersByTime(399));
    expect(api.previewImport).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(api.previewImport).toHaveBeenCalledTimes(1);
    expect(api.previewImport).toHaveBeenCalledWith({ text: 'nam', mode: 'new', targetId: undefined });
    expect(out(host).dataset.name).toBe('Support triage');
    expect(out(host).dataset.loading).toBe('false');
  });

  it('ignores a stale response that lands after the inputs changed', async () => {
    let resolveFirst!: (p: ImportPreview) => void;
    api.previewImport
      .mockImplementationOnce(() => new Promise<ImportPreview>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(preview({ spec: { version: 2, name: 'Second', model: 'm' } as unknown as ImportPreview['spec'] }));
    render(<Probe text="first" />);
    await act(async () => vi.advanceTimersByTime(400));
    expect(api.previewImport).toHaveBeenCalledTimes(1);

    rerender(<Probe text="second" />);
    await act(async () => vi.advanceTimersByTime(400));
    await flush();
    expect(api.previewImport).toHaveBeenCalledTimes(2);

    // The first request's answer arrives last and must not overwrite the second's.
    await act(async () => resolveFirst(preview({ spec: { version: 2, name: 'Stale', model: 'm' } as unknown as ImportPreview['spec'] })));
    await flush();
    expect(document.querySelector('output')!.dataset.name).toBe('Second');
  });

  it('maps a rejected request to { message, code }', async () => {
    const { RuntimeApiError } = await import('../../../../runtime/runtimeClient');
    api.previewImport.mockRejectedValue(new RuntimeApiError('tools[0].builtin: Unknown tool', 400, 'LOUSHO_SCHEMA'));
    const host = render(<Probe text="bad" />);
    await act(async () => vi.advanceTimersByTime(400));
    await flush();
    expect(out(host).dataset.error).toBe('tools[0].builtin: Unknown tool');
    expect(out(host).dataset.code).toBe('LOUSHO_SCHEMA');
    expect(out(host).dataset.loading).toBe('false');
  });

  it('re-requests when the mode changes so resolvedId follows the selection', async () => {
    api.previewImport.mockResolvedValue(preview());
    render(<Probe text="spec" mode="new" />);
    await act(async () => vi.advanceTimersByTime(400));
    await flush();
    expect(api.previewImport).toHaveBeenLastCalledWith({ text: 'spec', mode: 'new', targetId: undefined });

    rerender(<Probe text="spec" mode="replace" targetId="support-bot" />);
    await act(async () => vi.advanceTimersByTime(400));
    await flush();
    expect(api.previewImport).toHaveBeenLastCalledWith({ text: 'spec', mode: 'replace', targetId: 'support-bot' });
  });
});
