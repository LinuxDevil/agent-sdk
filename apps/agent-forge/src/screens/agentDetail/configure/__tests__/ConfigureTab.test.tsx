import { act, useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { render } from '../../../../ui/__tests__/render';
import { ToastProvider } from '../../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  saveAgent: vi.fn(),
  /** The spec the last `saveAgent` call persisted; `refresh` reseeds the record with it. */
  savedSpec: { current: null as AgentSpecV2 | null },
  refreshSpy: vi.fn(),
  appState: {
    agentId: 'support-bot' as string | undefined,
    dirty: false,
    switchAgent: vi.fn(),
  },
}));

vi.mock('../../../../runtime/runtimeClient', () => ({
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  runtimeClient: { saveAgent: mocks.saveAgent },
}));

vi.mock('../../../../state/AppState', () => ({
  useAppState: () => mocks.appState,
}));

import { AgentDetailContext } from '../../AgentDetailContext';
import { ConfigureTab } from '../ConfigureTab';

function meta(): AgentRecord['meta'] {
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
  };
}

function spec(over: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'Support bot',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Be helpful.',
    ...over,
  } as AgentSpecV2;
}

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: spec(),
    meta: meta(),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    requirements: [],
  };
}

/**
 * The detail route's host: `refresh` refetches the record, which in the
 * real app returns the just-saved spec. Here it swaps in the spec the last
 * `saveAgent` mock call persisted so the draft reseeds like production.
 */
function TabHost({ initial }: { initial: AgentRecord }) {
  const [rec, setRec] = useState(initial);
  const refresh = useCallback(() => {
    mocks.refreshSpy();
    setRec((r) => (mocks.savedSpec.current === null ? r : { ...r, spec: mocks.savedSpec.current }));
  }, []);
  return (
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: rec, refresh, setRecord: setRec }}>
        <ConfigureTab />
      </AgentDetailContext.Provider>
    </ToastProvider>
  );
}

function renderTab(rec: AgentRecord = record()) {
  const host = render(<TabHost initial={rec} />);
  return { host };
}

/** Flushes pending promises/state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => (el as HTMLElement).click());
}

const q = <T extends Element>(host: HTMLElement, selector: string) =>
  host.querySelector<T>(selector)!;

beforeEach(() => {
  mocks.saveAgent.mockReset();
  mocks.saveAgent.mockImplementation(async (_id: string, spec: AgentSpecV2) => {
    mocks.savedSpec.current = spec;
  });
  mocks.savedSpec.current = null;
  mocks.refreshSpy.mockReset();
  mocks.appState.agentId = 'support-bot';
  mocks.appState.dirty = false;
  mocks.appState.switchAgent.mockReset();
  window.location.hash = '#/agents/support-bot/configure';
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ConfigureTab', () => {
  it('renders the eight section cards and the index buttons', () => {
    const { host } = renderTab();

    const sections = host.querySelectorAll('section.configure-section');
    expect(sections.length).toBe(8);
    const headings = [...sections].map((s) => s.querySelector('.card-title')?.textContent);
    expect(headings).toEqual([
      'Identity',
      'Model',
      'Instructions',
      'Tools',
      'Knowledge',
      'Safety',
      'Triggers',
      'Output and limits',
    ]);
    const indexButtons = host.querySelectorAll<HTMLButtonElement>('.configure-index-item');
    expect(indexButtons.length).toBe(8);
    // Hidden keys never appear as fields.
    expect(host.querySelector('#configure-identity-version')).toBeNull();
  });

  it('marks the edited section dirty and shows the save bar count', () => {
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), 'Support bot 2');

    const identityItem = q<HTMLButtonElement>(host, '.configure-index-item[aria-current]');
    expect(identityItem.querySelector('.configure-dot')).not.toBeNull();
    expect(host.querySelector('.configure-savebar-text')?.textContent).toContain('1 section changed');
  });

  it('shows the required error, the index count and disables Save', () => {
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), '');

    expect(host.textContent).toContain('Required.');
    const identityItem = [...host.querySelectorAll<HTMLButtonElement>('.configure-index-item')].find(
      (b) => b.textContent?.includes('Identity'),
    )!;
    expect(identityItem.querySelector('.configure-issues')?.textContent).toContain('1');
    const save = q<HTMLButtonElement>(host, '.configure-savebar .btn-primary');
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Fix 1 problem first');
  });

  it('saves the draft, toasts, refreshes and reloads the clean canvas document', async () => {
    mocks.appState.dirty = false;
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), 'Support bot 2');
    const save = q<HTMLButtonElement>(host, '.configure-savebar .btn-primary');
    click(save);
    expect(save.textContent).toBe('Saving…');
    await flush();

    expect(mocks.saveAgent).toHaveBeenCalledWith(
      'support-bot',
      expect.objectContaining({ name: 'Support bot 2' }),
    );
    expect(mocks.refreshSpy).toHaveBeenCalled();
    expect(host.querySelector('.toast-message')?.textContent).toBe('Changes saved');
    expect(mocks.appState.switchAgent).toHaveBeenCalledWith('support-bot');
    // Clean draft → the save bar is gone.
    expect(host.querySelector('.configure-savebar')).toBeNull();
  });

  it('does not reload the canvas document when it has unsaved edits', async () => {
    mocks.appState.dirty = true;
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), 'Support bot 2');
    // The canvas-dirty note shows while the draft is unsaved.
    expect(host.querySelector('.configure-savebar-note')?.textContent).toContain('canvas has unsaved edits');
    click(q<HTMLButtonElement>(host, '.configure-savebar .btn-primary'));
    await flush();

    expect(mocks.saveAgent).toHaveBeenCalled();
    expect(mocks.appState.switchAgent).not.toHaveBeenCalled();
  });

  it('toasts the server error and stays dirty on a 400', async () => {
    const { RuntimeApiError } = await import('../../../../runtime/runtimeClient');
    mocks.saveAgent.mockRejectedValue(new RuntimeApiError('LOUSHO_SPEC_INVALID: tools.0', 400));
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), 'Support bot 2');
    click(q<HTMLButtonElement>(host, '.configure-savebar .btn-primary'));
    await flush();

    expect(host.querySelector('.toast-message')?.textContent).toBe('LOUSHO_SPEC_INVALID: tools.0');
    expect(host.querySelector('.configure-savebar')).not.toBeNull();
    expect(mocks.refreshSpy).not.toHaveBeenCalled();
  });

  it('Discard restores the saved spec and hides the save bar', () => {
    const { host } = renderTab();

    type(q<HTMLInputElement>(host, '#configure-identity-name'), 'Support bot 2');
    expect(q<HTMLInputElement>(host, '#configure-identity-name').value).toBe('Support bot 2');

    click(q<HTMLButtonElement>(host, '.configure-savebar .btn'));

    expect(q<HTMLInputElement>(host, '#configure-identity-name').value).toBe('Support bot');
    expect(host.querySelector('.configure-savebar')).toBeNull();
  });

  it('index click scrolls to the section and mirrors ?section= in the hash', () => {
    const { host } = renderTab();

    const modelButton = [...host.querySelectorAll<HTMLButtonElement>('.configure-index-item')].find(
      (b) => b.textContent?.includes('Model'),
    )!;
    click(modelButton);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(window.location.hash).toContain('section=model');
    expect(modelButton.getAttribute('aria-current')).toBe('true');
  });

  it('deep-links to ?section= on mount', () => {
    window.location.hash = '#/agents/support-bot/configure?section=model';
    const { host } = renderTab();

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    const modelButton = [...host.querySelectorAll<HTMLButtonElement>('.configure-index-item')].find(
      (b) => b.textContent?.includes('Model'),
    )!;
    expect(modelButton.getAttribute('aria-current')).toBe('true');
  });
});
