import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceListItem } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';

const client = vi.hoisted(() => ({ addWorkspace: vi.fn() }));
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { addWorkspace: client.addWorkspace },
  RuntimeApiError: class extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

import { RuntimeApiError } from '../../runtime/runtimeClient';
import { AddWorkspaceDialog } from '../AddWorkspaceDialog';

const ITEM: WorkspaceListItem = {
  id: 'new-1a2b3c',
  name: 'fresh-project',
  root: '/code/fresh-project',
  addedAt: '2025-01-01T00:00:00Z',
  lastOpenedAt: '2025-01-01T00:00:00Z',
  isLaunch: false,
  available: true,
  agentCount: 0,
  observeProject: 'default',
};

const input = () => document.body.querySelector<HTMLInputElement>('#add-workspace-form input')!;
const submitButton = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.type === 'submit')!;

async function type(text: string) {
  await act(async () => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => submitButton().click());
}

function mount(onAdded = vi.fn(), onClose = vi.fn()) {
  const host = render(<AddWorkspaceDialog open onClose={onClose} onAdded={onAdded} />);
  return { host, onAdded, onClose };
}

beforeEach(() => {
  client.addWorkspace.mockReset();
});

describe('AddWorkspaceDialog', () => {
  it('renders the title, description and folder-path field', () => {
    mount();
    expect(document.body.textContent).toContain('Add workspace');
    expect(document.body.textContent).toContain('Paste the folder');
    expect(input().placeholder).toBe('/path/to/project');
  });

  it('an empty submit shows the field error and sends no request', async () => {
    const { onAdded } = mount();
    await submit();
    expect(document.body.textContent).toContain('Enter a folder path.');
    expect(client.addWorkspace).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('trims the path and posts it to addWorkspace', async () => {
    client.addWorkspace.mockResolvedValue(ITEM);
    const { onAdded, onClose } = mount();
    await type('  /code/fresh-project  ');
    await submit();
    expect(client.addWorkspace).toHaveBeenCalledWith('/code/fresh-project');
    expect(onAdded).toHaveBeenCalledWith(ITEM);
    expect(onClose).toHaveBeenCalled();
  });

  it('disables both buttons and shows "Adding…" while pending', async () => {
    let resolve!: (v: WorkspaceListItem) => void;
    client.addWorkspace.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    await type('/code/x');
    await act(async () => {
      submitButton().click();
    });
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe('Adding…');
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!;
    expect(cancel.disabled).toBe(true);
    await act(async () => {
      resolve(ITEM);
    });
    await act(async () => {});
  });

  it('a 400/409 shows the server error under the field and keeps the dialog open', async () => {
    client.addWorkspace.mockRejectedValue(new RuntimeApiError('That folder is already a workspace.', 409));
    const { onAdded, onClose } = mount();
    await type('/code/dup');
    await submit();
    expect(document.body.textContent).toContain('That folder is already a workspace.');
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(false);
  });

  it('closing resets the input and error', async () => {
    client.addWorkspace.mockRejectedValue(new RuntimeApiError('bad path', 400));
    const { onClose } = mount();
    await type('/nope');
    await submit();
    expect(document.body.textContent).toContain('bad path');
    await act(async () => document.body.querySelector<HTMLButtonElement>('button.btn')!.click());
    expect(onClose).toHaveBeenCalled();
  });
});
