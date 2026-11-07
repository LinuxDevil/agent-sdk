import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const appState = vi.hoisted(() => ({
  saveVersion: vi.fn(async () => ({ version: 4 }) as { version: number } | undefined),
  latestVersion: 4 as number | null,
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { useSaveVersionShortcut } from '../useSaveVersionShortcut';

/** A stand-in for the builder screen: binds the shortcut and owns an editable field. */
function Probe() {
  useSaveVersionShortcut();
  return <input />;
}

function keydown(target: Window | Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mount() {
  return render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
}

describe('useSaveVersionShortcut', () => {
  beforeEach(() => {
    appState.saveVersion.mockClear();
    appState.saveVersion.mockResolvedValue({ version: 4 });
  });

  it('Ctrl+S runs saveVersion() and prevents the browser save dialog', async () => {
    mount();
    const event = keydown(window, { key: 's', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {});
    expect(appState.saveVersion).toHaveBeenCalledTimes(1);
  });

  it('Cmd+S (metaKey) does the same', async () => {
    mount();
    const event = keydown(window, { key: 's', metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {});
    expect(appState.saveVersion).toHaveBeenCalledTimes(1);
  });

  it('works while typing in an inspector field (it is a save, not text input)', async () => {
    const container = mount();
    const event = keydown(container.querySelector('input')!, { key: 's', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {});
    expect(appState.saveVersion).toHaveBeenCalledTimes(1);
  });

  it('plain s does nothing', async () => {
    mount();
    const event = keydown(window, { key: 's' });
    expect(event.defaultPrevented).toBe(false);
    await act(async () => {});
    expect(appState.saveVersion).not.toHaveBeenCalled();
  });
});
