import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvalGateResult, PublishState } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';
import { ToastProvider } from '../../ui/Toast';
import { RuntimeApiError } from '../../runtime/runtimeClient';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  save: vi.fn(async () => undefined),
}));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { publish: mocks.publish },
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string,
      public readonly details?: unknown,
      public readonly body?: unknown,
    ) {
      super(message);
    }
  },
}));

vi.mock('../../state/AppState', () => ({
  useAppState: () => ({ save: mocks.save }),
}));

import { PublishPill, PublishStatePill, publishLabel } from '../PublishPill';

function state(over: Partial<PublishState> = {}): PublishState {
  return { version: null, matchesWorkingCopy: false, publishedAt: null, ...over };
}

/** Mounts the pill inside the toast provider the toolbar provides. */
function renderPill(over: Partial<PublishState> = {}, props: { dirty?: boolean; onPublished?: (v: number) => void } = {}) {
  return render(
    <ToastProvider>
      <PublishPill
        agentId="support-bot"
        state={state(over)}
        dirty={props.dirty ?? false}
        onPublished={props.onPublished ?? (() => {})}
      />
    </ToastProvider>,
  );
}

/** The portalled menu item whose label contains `text`. */
function menuItem(text: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) =>
    b.textContent?.includes(text),
  )!;
}

/** Flushes the promise chain inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.publish.mockReset();
  mocks.save.mockClear();
  document.body.innerHTML = '';
});

describe('publishLabel', () => {
  it('reads "Not published" (neutral) when nothing is pinned', () => {
    expect(publishLabel(state())).toEqual({
      text: 'Not published',
      tone: 'neutral',
      title: 'Nothing is live yet. Publish to serve, deploy or run triggers from a fixed version.',
    });
  });

  it('reads "Published v7" (ok) when the working copy matches the pin', () => {
    expect(publishLabel(state({ version: 7, matchesWorkingCopy: true }))).toEqual({
      text: 'Published v7',
      tone: 'ok',
      title: 'v7 is live and matches what you are editing.',
    });
  });

  it('reads "Published v7 · edited" (warning) when the working copy drifted', () => {
    expect(publishLabel(state({ version: 7, matchesWorkingCopy: false }))).toEqual({
      text: 'Published v7 · edited',
      tone: 'warning',
      title: 'v7 is live. Your edits are not published yet.',
    });
  });
});

describe('PublishPill', () => {
  it('renders the pill as a menu trigger with the label text and tone class', () => {
    const host = renderPill({ version: 7, matchesWorkingCopy: false });
    const pill = host.querySelector<HTMLButtonElement>('button.publish-pill')!;
    expect(pill.className).toContain('status-pill');
    expect(pill.className).toContain('pill-warning');
    expect(pill.getAttribute('aria-haspopup')).toBe('menu');
    expect(pill.querySelector('.status-pill-label')?.textContent).toBe('Published v7 · edited');
    expect(pill.title).toBe('v7 is live. Your edits are not published yet.');
  });

  it('opens a menu with "Publish current version" and "View versions"', async () => {
    const host = renderPill();
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();

    expect(menuItem('Publish current version')).not.toBeUndefined();
    expect(menuItem('View versions')).not.toBeUndefined();
  });

  it('publishes directly when the editor is clean, toasts and calls onPublished', async () => {
    mocks.publish.mockResolvedValue({ publishedVersion: 4 });
    const onPublished = vi.fn();
    const host = renderPill({ version: 3, matchesWorkingCopy: false }, { onPublished });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();
    await act(async () => menuItem('Publish current version').click());
    await flush();

    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith('support-bot');
    expect(onPublished).toHaveBeenCalledWith(4);
    expect(host.querySelector('.toast-message')?.textContent).toBe('Published v4');
  });

  it('toasts "· evals passed" when the publish ran the eval gate (X01b)', async () => {
    const evalResult: EvalGateResult = {
      passed: true,
      gates: [{ dataset: 'ds', passRate: 1, minPassRate: 0.8, passed: true, examples: [] }],
      ranAt: '2026-01-02T03:04:05.000Z',
    };
    mocks.publish.mockResolvedValue({ publishedVersion: 4, evalResult });
    const host = renderPill({ version: null });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();
    await act(async () => menuItem('Publish current version').click());
    await flush();

    expect(host.querySelector('.toast-message')?.textContent).toBe('Published v4 · evals passed');
  });

  it('opens the eval gate dialog on a 409 LOUSHO_EVAL_GATE_FAILED instead of toasting', async () => {
    const evalResult: EvalGateResult = {
      passed: false,
      gates: [
        {
          dataset: 'ds',
          passRate: 0.5,
          minPassRate: 0.8,
          passed: false,
          examples: [{ exampleId: 'abcdef123456', passed: false, failures: ['Took 9 steps, limit 5'], traceId: 't1' }],
        },
      ],
      ranAt: '2026-01-02T03:04:05.000Z',
    };
    mocks.publish.mockRejectedValue(
      new RuntimeApiError('Eval gate failed', 409, 'LOUSHO_EVAL_GATE_FAILED', evalResult, { version: 6, error: 'Eval gate failed', code: 'LOUSHO_EVAL_GATE_FAILED', details: evalResult })
    );
    const onPublished = vi.fn();
    const host = renderPill({ version: null }, { onPublished });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();
    await act(async () => menuItem('Publish current version').click());
    await flush();

    expect(onPublished).not.toHaveBeenCalled();
    expect(host.querySelector('.toast-message')).toBeNull();
    expect(document.querySelector('.dialog-title')?.textContent).toBe('Eval gate failed');
    expect(document.querySelector('.dialog-description')?.textContent).toBe(
      'v6 was not published. Fix the failures or change the gate, then publish again.'
    );
    expect(document.querySelector('.eval-gate-set-name')?.textContent).toBe('ds');
    expect(document.querySelector('.eval-gate-example-failures li')?.textContent).toBe('Took 9 steps, limit 5');

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.dialog-footer button')].find((b) => b.textContent === 'Close')!.click());
    await flush();
    expect(document.querySelector('.dialog-title')).toBeNull();
  });

  it('saves the dirty working copy before publishing', async () => {
    mocks.publish.mockResolvedValue({ publishedVersion: 2 });
    const order: string[] = [];
    mocks.save.mockImplementation(async () => {
      order.push('save');
    });
    mocks.publish.mockImplementation(async () => {
      order.push('publish');
      return { publishedVersion: 2 };
    });
    const host = renderPill({ version: null }, { dirty: true });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();
    await act(async () => menuItem('Publish current version').click());
    await flush();

    expect(order).toEqual(['save', 'publish']);
    expect(host.querySelector('.toast-message')?.textContent).toBe('Published v2');
  });

  it('disables "Publish current version" with "Already published" when the working copy matches', async () => {
    const host = renderPill({ version: 7, matchesWorkingCopy: true });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();

    const item = menuItem('Publish current version');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.title).toBe('Already published');
    await act(async () => item.click());
    await flush();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('shows the busy pill while publishing and toasts the failure', async () => {
    let rejectPublish: ((e: Error) => void) | undefined;
    mocks.publish.mockReturnValue(new Promise((_, reject) => (rejectPublish = reject)));
    const host = renderPill({ version: null });
    act(() => host.querySelector<HTMLButtonElement>('button.publish-pill')!.click());
    await flush();
    await act(async () => menuItem('Publish current version').click());
    await flush();

    const pill = host.querySelector<HTMLButtonElement>('button.publish-pill')!;
    expect(pill.getAttribute('aria-busy')).toBe('true');
    expect(pill.querySelector('.status-pill-label')?.textContent).toBe('Running evals…');

    await act(async () => rejectPublish?.(new Error('boom')));
    await flush();
    expect(host.querySelector('.toast-message')?.textContent).toBe("Couldn't publish: boom");
    expect(host.querySelector<HTMLButtonElement>('button.publish-pill')!.getAttribute('aria-busy')).toBeNull();
  });
});

describe('PublishStatePill', () => {
  it('renders the same label read-only (no button, no menu)', () => {
    const host = render(
      <PublishStatePill state={state({ version: 2, matchesWorkingCopy: true })} />,
    );
    const pill = host.querySelector<HTMLElement>('.status-pill')!;
    expect(pill.className).toContain('pill-ok');
    expect(pill.title).toBe('v2 is live and matches what you are editing.');
    expect(pill.textContent).toContain('Published v2');
    expect(host.querySelector('button')).toBeNull();
  });
});
