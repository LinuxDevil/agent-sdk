import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VersionListItem } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { RestoreDialog } from '../RestoreDialog';

const mocks = vi.hoisted(() => ({
  restoreVersion: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { restoreVersion: mocks.restoreVersion },
}));

function restoredItem(): VersionListItem {
  return {
    version: 8,
    kind: 'restore',
    source: 'restore',
    changedFields: [],
    restoredFromVersion: 3,
    summary: null,
    requestText: null,
    authorSessionId: null,
    specHash: 'def',
    createdAt: '2026-11-11T00:00:00.000Z',
  };
}

function renderDialog(over: Partial<Parameters<typeof RestoreDialog>[0]> = {}) {
  const props = {
    agentId: 'support-bot',
    version: 3,
    nextVersion: 8,
    dirty: false,
    open: true,
    onClose: vi.fn(),
    onRestored: vi.fn(),
    ...over,
  };
  render(<RestoreDialog {...props} />);
  return props;
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="alertdialog"]')!;
}

function button(label: string): HTMLButtonElement {
  return [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  )!;
}

/** Lets pending promises and state updates settle inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.restoreVersion.mockReset();
  mocks.restoreVersion.mockResolvedValue(restoredItem());
});

describe('RestoreDialog', () => {
  it('renders nothing while closed and the exact copy while open', () => {
    renderDialog({ open: false });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    renderDialog();
    expect(dialog().querySelector('.dialog-title')?.textContent).toBe('Restore v3?');
    expect(dialog().textContent).toContain(
      'This writes v8 with the configuration from v3. Everything up to v7 stays in the history.',
    );
    expect(dialog().querySelector('.dialog-hint')?.textContent).toBe(
      "The agent's on/off switch and published version do not change.",
    );
    expect(dialog().querySelector('.dialog-warning')).toBeNull();
    expect(button('Cancel').className).toContain('btn-secondary');
    expect(button('Restore v3').className).toContain('btn-primary');
  });

  it('warns about unsaved edits only when dirty', () => {
    renderDialog({ dirty: true });
    const warning = dialog().querySelector('.dialog-warning')!;
    expect(warning.textContent).toBe('You have unsaved edits. Restoring replaces them.');
    expect(warning.getAttribute('role')).toBe('alert');
  });

  it('confirm posts the restore and hands the new item to onRestored', async () => {
    const props = renderDialog();
    await act(async () => {
      button('Restore v3').click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.restoreVersion).toHaveBeenCalledWith('support-bot', 3);
    expect(props.onRestored).toHaveBeenCalledWith(restoredItem());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('disables both buttons and shows a spinner while the request runs', async () => {
    let resolveRestore!: (item: VersionListItem) => void;
    mocks.restoreVersion.mockReturnValue(new Promise((resolve) => (resolveRestore = resolve)));
    renderDialog();

    await act(async () => {
      button('Restore v3').click();
    });
    await flush();

    const footer = dialog().querySelector('.dialog-footer')!;
    expect([...footer.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    expect(button('Restore v3').querySelector('.btn-spinner')).not.toBeNull();
    // Escape cannot close an in-flight restore.
    act(() => {
      dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog()).not.toBeNull();

    await act(async () => {
      resolveRestore(restoredItem());
      await Promise.resolve();
    });
    await flush();
  });

  it('keeps the dialog open with the server error on failure', async () => {
    mocks.restoreVersion.mockRejectedValue(new Error('v3 is already the current version.'));
    const props = renderDialog();

    await act(async () => {
      button('Restore v3').click();
      await Promise.resolve();
    });
    await flush();

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const error = dialog().querySelector('.dialog-error')!;
    expect(error.textContent).toBe('v3 is already the current version.');
    expect(error.getAttribute('role')).toBe('alert');
    expect(props.onRestored).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    // Buttons are usable again for a retry.
    expect(button('Restore v3').disabled).toBe(false);
  });

  it('Cancel closes without calling the route', async () => {
    const props = renderDialog();
    await act(async () => {
      button('Cancel').click();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.restoreVersion).not.toHaveBeenCalled();
  });
});
