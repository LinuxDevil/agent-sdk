import { act, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import { AgentDetailContext } from '../AgentDetailContext';
import { AutoDisableNotice, EnabledControl } from '../EnabledControl';

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

function record(over: { meta?: Partial<AgentRecord['meta']> } = {}): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      description: 'Answers billing questions.',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    },
    meta: meta(over.meta),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
  };
}

/** Mounts the pill + notice over a stateful record so setRecord really swaps it. */
function Harness({ initial }: { initial: AgentRecord }) {
  const [rec, setRec] = useState(initial);
  return (
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: rec, refresh: vi.fn(), setRecord: setRec }}>
        <EnabledControl record={rec} />
        <AutoDisableNotice record={rec} />
      </AgentDetailContext.Provider>
    </ToastProvider>
  );
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

const pill = (host: HTMLElement) => host.querySelector<HTMLElement>('.enabled-control')!;
const sw = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
const toastText = () => [...document.querySelectorAll('.toast-message')].map((t) => t.textContent);

beforeEach(() => {
  mocks.patchAgentMeta.mockReset();
});

describe('EnabledControl', () => {
  it('shows Enabled with a halo dot and a checked switch', () => {
    const host = render(<Harness initial={record()} />);
    expect(pill(host).classList.contains('is-on')).toBe(true);
    expect(host.querySelector('.status-dot-halo')).not.toBeNull();
    expect(host.querySelector('.enabled-control-text')?.textContent).toBe('Enabled');
    expect(sw(host).getAttribute('aria-checked')).toBe('true');
    expect(sw(host).getAttribute('aria-label')).toBe('Agent enabled');
  });

  it('toggles optimistically on a pill click, then toasts on success', async () => {
    let resolve!: (meta: AgentRecord['meta']) => void;
    mocks.patchAgentMeta.mockReturnValue(new Promise((r) => (resolve = r)));
    const host = render(<Harness initial={record()} />);

    act(() => host.querySelector('.enabled-control-text')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(mocks.patchAgentMeta).toHaveBeenCalledWith('support-bot', { enabled: false });
    expect(sw(host).getAttribute('aria-checked')).toBe('false');
    expect(sw(host).disabled).toBe(true);
    expect(pill(host).hasAttribute('data-pending')).toBe(true);

    await act(async () => {
      resolve(meta({ enabled: false, disabledAt: '2026-10-29T11:00:00Z', disabledReason: 'manual' }));
      await Promise.resolve();
    });
    expect(sw(host).disabled).toBe(false);
    expect(toastText()).toContain('“Support bot” is off');
  });

  it('reverts and toasts the error on failure', async () => {
    mocks.patchAgentMeta.mockRejectedValue(new Error('meta is locked'));
    const host = render(<Harness initial={record()} />);

    act(() => pill(host).click());
    await flush();

    expect(sw(host).getAttribute('aria-checked')).toBe('true');
    expect(pill(host).classList.contains('is-on')).toBe(true);
    expect(document.querySelector('.toast-error .toast-message')?.textContent).toBe('meta is locked');
  });

  it('shows the auto-disable notice with the date', () => {
    const host = render(
      <Harness
        initial={record({
          meta: { enabled: false, disabledReason: 'auto_failure_streak', disabledAt: '2026-10-29T10:00:00Z' },
        })}
      />,
    );
    const notice = host.querySelector('.agent-detail-notice')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(/^Turned off after 5 failed runs in a row on /);
    expect(notice.textContent).toContain('Fix the cause, then turn it back on.');
  });

  it('shows no notice for a manual disable or an enabled agent', () => {
    const host = render(<Harness initial={record({ meta: { enabled: false, disabledReason: 'manual' } })} />);
    expect(host.querySelector('.agent-detail-notice')).toBeNull();
  });
});
