import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ rateRun: vi.fn() }));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: api,
  RuntimeApiError: class RuntimeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { RatingControl } from '../RatingControl';
import { render } from './render';
import { ToastProvider } from '../Toast';

function mount(props: Partial<Parameters<typeof RatingControl>[0]> = {}) {
  return render(
    <ToastProvider>
      <RatingControl agentId="support-bot" traceId="t-1" value={null} {...props} />
    </ToastProvider>,
  );
}

async function settle() {
  await act(async () => {});
}

const option = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`.rating [aria-label="${label}"]`)!;
const key = (k: string, target: Element) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  api.rateRun.mockReset().mockResolvedValue(undefined);
});

describe('RatingControl', () => {
  it('renders nothing without a traceId', () => {
    const container = mount({ traceId: '' });
    expect(container.querySelector('.rating')).toBeNull();
  });

  it('posts the clicked value and lights options up to it', async () => {
    const onRated = vi.fn();
    const container = mount({ onRated });
    await act(async () => option(container, '2, Fair').click());
    await settle();

    expect(api.rateRun).toHaveBeenCalledWith('support-bot', { traceId: 't-1', value: 2 });
    expect(onRated).toHaveBeenCalledWith(2);
    expect(container.querySelectorAll('.rating-option-on').length).toBe(2);
    expect(option(container, '2, Fair').getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain("It's in your Inbox");
  });

  it('toasts the thanks message for ratings of 3 and up', async () => {
    const container = mount();
    await act(async () => option(container, '5, Excellent').click());
    await settle();
    expect(container.textContent).toContain('Thanks — rating saved');
  });

  it('reverts the optimistic state and toasts the server message on error', async () => {
    api.rateRun.mockRejectedValue(new Error('daemon said no'));
    const container = mount({ value: 4 });
    await act(async () => option(container, '1, Poor').click());
    await settle();

    expect(container.textContent).toContain('daemon said no');
    // Back to the stored 4: options 1-4 on, option 4 checked.
    expect(container.querySelectorAll('.rating-option-on').length).toBe(4);
    expect(option(container, '4, Great').getAttribute('aria-checked')).toBe('true');
  });

  it('uses the observe-daemon message on a 502', async () => {
    const { RuntimeApiError } = await import('../../runtime/runtimeClient');
    api.rateRun.mockRejectedValue(new RuntimeApiError('bad gateway', 502));
    const container = mount();
    await act(async () => option(container, '3, Good').click());
    await settle();
    expect(container.textContent).toContain('The observe daemon is not running. Start it with lousho observe.');
  });

  it('moves focus and selects with Arrow Left/Right (roving tabindex)', async () => {
    const container = mount({ value: 3 });
    const group = container.querySelector<HTMLElement>('.rating')!;
    // Only the checked option is tabbable.
    expect(option(container, '3, Good').tabIndex).toBe(0);
    expect(option(container, '1, Poor').tabIndex).toBe(-1);

    key('ArrowRight', group);
    await settle();
    expect(document.activeElement).toBe(option(container, '4, Great'));
    expect(api.rateRun).toHaveBeenCalledWith('support-bot', { traceId: 't-1', value: 4 });

    key('ArrowLeft', group);
    await settle();
    expect(document.activeElement).toBe(option(container, '3, Good'));
    expect(api.rateRun).toHaveBeenLastCalledWith('support-bot', { traceId: 't-1', value: 3 });
  });

  it('saves a comment by re-sending the current value', async () => {
    const container = mount({ value: 2 });
    await act(async () => container.querySelector<HTMLButtonElement>('.rating-comment')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('.rating-popover textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'missed the refund');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>('.rating-popover button')].find(
      (b) => b.textContent === 'Save',
    )!;
    await act(async () => save.click());
    await settle();

    expect(api.rateRun).toHaveBeenCalledWith('support-bot', {
      traceId: 't-1',
      value: 2,
      comment: 'missed the refund',
    });
    expect(container.querySelector('.rating-popover')).toBeNull();
  });

  it('disables the comment Save until a rating exists', async () => {
    const container = mount({ value: null });
    await act(async () => container.querySelector<HTMLButtonElement>('.rating-comment')!.click());
    const save = [...container.querySelectorAll<HTMLButtonElement>('.rating-popover button')].find(
      (b) => b.textContent === 'Save',
    )!;
    expect(save.disabled).toBe(true);
  });
});
