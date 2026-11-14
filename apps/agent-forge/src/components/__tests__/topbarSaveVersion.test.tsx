import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { ToastProvider } from '../../ui/Toast';

const appState = vi.hoisted(() => ({
  spec: { name: 'demo', prompt: 'x', provider: { type: 'mock', model: 'echo' } },
  graph: { nodes: [], edges: [] },
  agentId: 'demo',
  dirty: false,
  runStatus: undefined,
  spans: [],
  problems: [] as Array<{ nodeId: string; severity: 'error' | 'warning'; message: string; fieldPath?: string }>,
  debugMode: false,
  setDebugMode: vi.fn(),
  setDrawerTab: vi.fn(),
  runAgent: vi.fn(async () => {}),
  stopAgent: vi.fn(async () => {}),
  setSpec: vi.fn(),
  saveVersion: vi.fn(async () => ({ version: 3 }) as { version: number } | undefined),
  latestVersion: 3 as number | null,
  activeProfile: undefined,
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { Topbar } from '../Topbar';

function saveButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[title="Save"]') as HTMLButtonElement;
}

describe('Topbar Save (explicit version)', () => {
  beforeEach(() => {
    appState.saveVersion.mockClear();
    appState.latestVersion = 3;
  });

  it('click Save calls saveVersion() and toasts "Saved version v<n>" when a version was written', async () => {
    appState.saveVersion.mockResolvedValue({ version: 3 });
    const container = render(
      <ToastProvider>
        <Topbar />
      </ToastProvider>,
    );
    await act(async () => saveButton(container).click());
    expect(appState.saveVersion).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.toast-message')?.textContent).toBe('Saved version v3');
  });

  it('toasts "No changes since v<n>" when the save was the server\'s 200 no-op', async () => {
    appState.saveVersion.mockResolvedValue(undefined);
    appState.latestVersion = 2;
    const container = render(
      <ToastProvider>
        <Topbar />
      </ToastProvider>,
    );
    await act(async () => saveButton(container).click());
    expect(appState.saveVersion).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.toast-message')?.textContent).toBe('No changes since v2');
  });

  it('a failed saveVersion surfaces the existing error notice instead of a toast', async () => {
    appState.saveVersion.mockRejectedValue(new Error('save broke'));
    const container = render(
      <ToastProvider>
        <Topbar />
      </ToastProvider>,
    );
    await act(async () => saveButton(container).click());
    expect(container.querySelector('.run-error')?.textContent).toBe('save broke');
    expect(container.querySelector('.toast')).toBeNull();
  });
});

describe('Topbar Run gating (C19)', () => {
  beforeEach(() => {
    appState.problems = [];
  });

  it('disables Run with the error count in its title when error problems exist', () => {
    appState.problems = [
      { nodeId: 'agent', severity: 'error', message: 'e1' },
      { nodeId: 'tool:x', severity: 'warning', message: 'w1' },
      { nodeId: 'tool:y', severity: 'error', message: 'e2' },
    ];
    const container = render(
      <ToastProvider>
        <Topbar />
      </ToastProvider>,
    );
    const run = container.querySelector('button[title="Fix 2 problems first"]') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });

  it('keeps Run enabled when only warnings exist', () => {
    appState.problems = [{ nodeId: 'agent', severity: 'warning', message: 'w1' }];
    const container = render(
      <ToastProvider>
        <Topbar />
      </ToastProvider>,
    );
    const run = container.querySelector('button[title="Run"]') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
  });
});
