import { act, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import { AgentDetailContext } from '../AgentDetailContext';
import { HeaderLabels } from '../LabelsEditor';

const mocks = vi.hoisted(() => ({
  patchAgentMeta: vi.fn(),
  MockRuntimeApiError: class MockRuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'RuntimeApiError';
    }
  },
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { patchAgentMeta: mocks.patchAgentMeta },
  RuntimeApiError: mocks.MockRuntimeApiError,
}));

function meta(over: Partial<AgentRecord['meta']> = {}): AgentRecord['meta'] {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-10-29T09:00:00Z',
    updatedAt: '2026-10-29T09:00:00Z',
    ...over,
  };
}

function record(labels: string[]): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      description: 'Answers billing questions.',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    },
    meta: meta({ labels }),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
  };
}

function Harness({ initial }: { initial: AgentRecord }) {
  const [rec, setRec] = useState(initial);
  return (
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: rec, refresh: vi.fn(), setRecord: setRec }}>
        <HeaderLabels record={rec} />
      </AgentDetailContext.Provider>
    </ToastProvider>
  );
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const factLabels = (host: HTMLElement) => [...host.querySelectorAll('.agent-detail-label')].map((li) => li.textContent);
const dialog = () => document.querySelector<HTMLElement>('.dialog');
const dialogInput = () => document.querySelector<HTMLInputElement>('.labels-input-field')!;
const dialogChips = () => [...document.querySelectorAll('.labels-chip')].map((c) => c.firstChild!.textContent);
const saveButton = () => [...document.querySelectorAll<HTMLButtonElement>('.dialog-footer button')].find((b) => b.textContent === 'Save' || b.textContent === 'Saving…')!;
const problem = () => document.querySelector('.field-error')?.textContent;

function type(value: string) {
  const el = dialogInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    dialogInput().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });

const click = (el: Element) => act(() => (el as HTMLElement).click());

function openDialog(host: HTMLElement) {
  click(host.querySelector('button[aria-label="Edit labels"]')!);
}

beforeEach(() => {
  mocks.patchAgentMeta.mockReset();
});

describe('HeaderLabels', () => {
  it('shows three chips plus +N for the rest, and No labels when empty', () => {
    const host = render(<Harness initial={record(['l1', 'l2', 'l3', 'l4', 'l5'])} />);
    expect(factLabels(host)).toEqual(['l1', 'l2', 'l3']);
    const more = host.querySelector('.agent-detail-label-more')!;
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('title')).toBe('l4, l5');

    const empty = render(<Harness initial={record([])} />);
    expect(empty.querySelector('.value-missing')?.textContent).toBe('No labels');
    expect(empty.querySelector('.agent-detail-labels')).toBeNull();
  });

  it('adds labels in the dialog, dedupes silently, collapses inner whitespace and Backspace removes the last chip', () => {
    const host = render(<Harness initial={record(['alpha'])} />);
    openDialog(host);
    expect(dialog()?.textContent).toContain('Edit labels');
    expect(dialogChips()).toEqual(['alpha']);

    type('Billing  Ops');
    key('Enter');
    expect(dialogChips()).toEqual(['alpha', 'billing ops']);
    expect(dialogInput().value).toBe('');

    // A duplicate normalises away silently: no problem, chips unchanged.
    type('billing ops');
    key('Enter');
    expect(problem()).toBeUndefined();
    expect(dialogChips()).toEqual(['alpha', 'billing ops']);

    // Empty the draft text, then Backspace removes the last chip.
    type('');
    key('Backspace');
    expect(dialogChips()).toEqual(['alpha']);
  });

  it('refuses a label over 32 characters with the LabelError message and keeps the chips unchanged', () => {
    const host = render(<Harness initial={record(['alpha'])} />);
    openDialog(host);

    const tooLong = 'x'.repeat(33);
    type(tooLong);
    // The live check shows the message before Enter is even pressed.
    expect(problem()).toBe(`Label "${tooLong}" is longer than 32 characters.`);
    key('Enter');
    expect(problem()).toBe(`Label "${tooLong}" is longer than 32 characters.`);
    expect(dialogChips()).toEqual(['alpha']);

    // Fixing the text clears the live problem.
    type('fine');
    expect(problem()).toBeUndefined();
    key('Enter');
    expect(dialogChips()).toEqual(['alpha', 'fine']);
  });

  it('saves through patchAgentMeta, closes and toasts; Save is disabled when unchanged', async () => {
    mocks.patchAgentMeta.mockImplementation((_id: string, patch: { labels?: string[] }) =>
      Promise.resolve(meta({ labels: patch.labels ?? [] })),
    );
    const host = render(<Harness initial={record(['alpha'])} />);
    openDialog(host);

    // Nothing changed yet: Save stays disabled.
    expect(saveButton().disabled).toBe(true);

    type('Beta');
    key('Enter');
    expect(saveButton().disabled).toBe(false);

    click(saveButton());
    await flush();

    expect(mocks.patchAgentMeta).toHaveBeenCalledWith('support-bot', { labels: ['alpha', 'beta'] });
    expect(dialog()).toBeNull();
    expect(document.querySelector('.toast-message')?.textContent).toBe('Labels saved');
    // The header fact picked up the saved labels.
    expect(factLabels(host)).toEqual(['alpha', 'beta']);
  });

  it('adds on comma and comma paste, removes a chip, shows a save error and re-seeds on reopen', async () => {
    mocks.patchAgentMeta.mockRejectedValue(new Error('daemon down'));
    const host = render(<Harness initial={record(['alpha'])} />);
    openDialog(host);

    type('beta');
    key(',');
    expect(dialogChips()).toEqual(['alpha', 'beta']);

    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      act(() => {
        dialogInput().dispatchEvent(event);
      });
      return event;
    };
    expect(paste('plain').defaultPrevented).toBe(false);
    expect(dialogChips()).toEqual(['alpha', 'beta']);
    expect(paste('gamma, delta').defaultPrevented).toBe(true);
    expect(dialogChips()).toEqual(['alpha', 'beta', 'gamma', 'delta']);

    click(document.querySelector('button[aria-label="Remove label beta"]')!);
    expect(dialogChips()).toEqual(['alpha', 'gamma', 'delta']);

    click(saveButton());
    await flush();
    expect(mocks.patchAgentMeta).toHaveBeenCalledWith('support-bot', { labels: ['alpha', 'gamma', 'delta'] });
    expect(problem()).toBe('daemon down');
    expect(dialog()).not.toBeNull();
    expect(saveButton().textContent).toBe('Save');
    expect(dialogInput().getAttribute('aria-describedby')).toBe(document.querySelector('.field-error')!.id);

    click([...document.querySelectorAll<HTMLButtonElement>('.dialog-footer button')].find((b) => b.textContent === 'Cancel')!);
    expect(dialog()).toBeNull();
    openDialog(host);
    expect(dialogChips()).toEqual(['alpha']);
    expect(problem()).toBeUndefined();
    expect(dialogInput().value).toBe('');
    expect(saveButton().disabled).toBe(true);
  });
});
