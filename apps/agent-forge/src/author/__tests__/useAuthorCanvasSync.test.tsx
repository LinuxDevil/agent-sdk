import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUserMessage,
  ProposalOutput,
} from '../../../shared/authorWire';
import type { ProposalOverlay } from '../../graph/v2/proposal';
import { fireAgentSaved } from '../authorEvents';
import { cleanup, render, rerender } from '../../ui/__tests__/render';

/**
 * The AppState slice the hook reads; mutable so a test can flip `dirty`,
 * and `proposal` behaves like the real overlay state: `showProposal`
 * sets it, `hideProposal` clears it (AppState owns it, not the hook).
 */
const appState = vi.hoisted(() => ({
  spec: { version: 2, name: 'bot', model: 'm', instructions: 'i' } as unknown,
  proposal: undefined as ProposalOverlay | undefined,
  showProposal: vi.fn(),
  hideProposal: vi.fn(),
  dirty: false,
  reload: vi.fn(async () => true),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

/** The Author chat slice: `messages` + the live turn's assistant message. */
const chatState = vi.hoisted(() => ({
  value: {
    messages: [] as AuthorMessage[],
    active: null as { requestId: string; lastSeq: number; assistant: AuthorAssistantMessage } | null,
  },
}));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => ({ state: chatState.value }) }));

const toastApi = vi.hoisted(() => ({ show: vi.fn(), dismiss: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ useToast: () => toastApi }));

import { useAuthorCanvasSync } from '../useAuthorCanvasSync';

function proposal(id: string, agentId = 'a1'): ProposalOutput {
  return {
    ok: true,
    proposalId: id,
    kind: 'update',
    agentId,
    spec: { version: 2, name: 'bot', model: `model-${id}`, instructions: 'i' },
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: 'hash',
    enabled: true,
  };
}

/** An assistant message carrying one ok `proposeAgentUpdate` part. */
function proposeMessage(id: string, agentId = 'a1'): { message: AuthorAssistantMessage; output: ProposalOutput } {
  const output = proposal(id, agentId);
  const part: AuthorToolPart = {
    type: 'tool',
    toolCallId: id,
    name: 'proposeAgentUpdate',
    input: {},
    state: 'done',
    output,
  };
  return {
    message: { id: `m_${id}`, role: 'assistant', parts: [part], at: '2026-01-01T00:00:00.000Z' },
    output,
  };
}

/** A settled user message carrying a save uiEvent for `proposalId`. */
function saveMessage(proposalId: string, agentId = 'a1'): AuthorUserMessage {
  return {
    id: `u_save_${proposalId}`,
    role: 'user',
    text: '',
    at: '2026-01-01T00:00:01.000Z',
    uiEvent: { kind: 'save', proposalId, agentId, version: 2 },
  };
}

/** An assistant message whose ok `discardPendingChanges` retires the open card. */
function discardMessage(agentId = 'a1'): AuthorAssistantMessage {
  const part: AuthorToolPart = {
    type: 'tool',
    toolCallId: 'tc_discard',
    name: 'discardPendingChanges',
    input: {},
    state: 'done',
    output: { ok: true, agentId },
  };
  return { id: 'm_discard', role: 'assistant', parts: [part], at: '2026-01-01T00:00:02.000Z' };
}

/** Lets the listener's async body (await reload, then toast) run to completion. */
async function flushSave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Probe({ agentId = 'a1' }: { agentId?: string }) {
  const { overlayProposalId } = useAuthorCanvasSync(agentId);
  return <output data-testid="overlay-id">{overlayProposalId ?? ''}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.dirty = false;
  appState.proposal = undefined;
  // mockImplementation survives clearAllMocks - pin the default here.
  appState.reload.mockImplementation(async () => true);
  // Behave like the real AppState overlay setters so `proposal` stays the
  // single source of truth the hook derives `overlayProposalId` from.
  appState.showProposal.mockImplementation((p: ProposalOverlay) => {
    appState.proposal = p;
  });
  appState.hideProposal.mockImplementation(() => {
    appState.proposal = undefined;
  });
  chatState.value = { messages: [], active: null };
});

describe('useAuthorCanvasSync overlay', () => {
  it("shows the open update card's spec through C21's setter, tagged with the proposal id", () => {
    const { message, output } = proposeMessage('p_show');
    chatState.value = { messages: [message], active: null };
    const container = render(<Probe />);
    // Sync render: the real AppState re-renders when showProposal sets
    // `proposal`; the mock only mutates it, so rerender to pick it up.
    rerender(<Probe />);
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
    expect(appState.showProposal).toHaveBeenCalledWith({ proposalId: 'p_show', spec: output.spec });
    expect(container.querySelector('[data-testid="overlay-id"]')!.textContent).toBe('p_show');
  });

  it('clears the overlay when the screen switches to another agent', () => {
    const { message } = proposeMessage('p_switch');
    chatState.value = { messages: [message], active: null };
    const container = render(<Probe agentId="a1" />);
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
    rerender(<Probe agentId="a2" />);
    expect(appState.hideProposal).toHaveBeenCalled();
    expect(appState.proposal).toBeUndefined();
    expect(container.querySelector('[data-testid="overlay-id"]')!.textContent).toBe('');
  });

  it('a newer card replaces the overlay', () => {
    const first = proposeMessage('p_newer1');
    chatState.value = { messages: [first.message], active: null };
    render(<Probe />);
    expect(appState.showProposal).toHaveBeenLastCalledWith({ proposalId: 'p_newer1', spec: first.output.spec });
    const second = proposeMessage('p_newer2');
    chatState.value = { messages: [first.message, second.message], active: null };
    rerender(<Probe />);
    expect(appState.showProposal).toHaveBeenCalledTimes(2);
    expect(appState.showProposal).toHaveBeenLastCalledWith({ proposalId: 'p_newer2', spec: second.output.spec });
  });

  it('a saved card clears the overlay', () => {
    const { message } = proposeMessage('p_saved');
    chatState.value = { messages: [message], active: null };
    const container = render(<Probe />);
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
    chatState.value = { messages: [message, saveMessage('p_saved')], active: null };
    rerender(<Probe />);
    expect(appState.hideProposal).toHaveBeenCalled();
    expect(appState.proposal).toBeUndefined();
    expect(container.querySelector('[data-testid="overlay-id"]')!.textContent).toBe('');
  });

  it('a discarded card clears the overlay', () => {
    const { message } = proposeMessage('p_discarded');
    chatState.value = { messages: [message], active: null };
    render(<Probe />);
    chatState.value = { messages: [message, discardMessage()], active: null };
    rerender(<Probe />);
    expect(appState.hideProposal).toHaveBeenCalled();
  });

  it('does not recompute the overlay on stream frames', () => {
    const { message } = proposeMessage('p_stream');
    chatState.value = { messages: [message], active: null };
    render(<Probe />);
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
    // Three "text.delta" frames: a fresh active assistant each time.
    for (let i = 1; i <= 3; i += 1) {
      chatState.value = {
        messages: [message],
        active: {
          requestId: 'r1',
          lastSeq: i,
          assistant: {
            id: 'live',
            role: 'assistant',
            parts: [{ type: 'text', text: 'x'.repeat(i) }],
            at: '2026-01-01T00:00:03.000Z',
          },
        },
      };
      rerender(<Probe />);
    }
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
  });

  it('re-shows the overlay when it is hidden from outside while the card stays actionable', () => {
    const { message } = proposeMessage('p_external');
    chatState.value = { messages: [message], active: null };
    render(<Probe />);
    rerender(<Probe />); // sync: proposal is now set, like a real AppState re-render
    expect(appState.showProposal).toHaveBeenCalledTimes(1);
    expect(appState.proposal?.proposalId).toBe('p_external');
    // What ProposalBanner's Hide and agentActionsClearing (rename/delete
    // of ANY agent) do: hideProposal straight on AppState, bypassing the
    // hook. The card is still actionable, so the overlay must come back.
    act(() => {
      appState.hideProposal();
    });
    expect(appState.proposal).toBeUndefined();
    rerender(<Probe />);
    expect(appState.showProposal).toHaveBeenCalledTimes(2);
    expect(appState.proposal?.proposalId).toBe('p_external');
  });

  it('a save while the screen is unmounted reloads and clears the stale overlay on remount', async () => {
    const { message } = proposeMessage('p_away');
    chatState.value = { messages: [message], active: null };
    render(<Probe />);
    expect(appState.proposal?.proposalId).toBe('p_away');
    // Navigate away: AgentsScreen unmounts, AppState.proposal stays set.
    cleanup();
    // The Author saves from the dock while no canvas is mounted.
    const saved = proposeMessage('p_away');
    chatState.value = { messages: [saved.message, saveMessage('p_away')], active: null };
    await act(async () => {
      fireAgentSaved('a1');
    });
    // Remount: the card is saved (no overlay justified) but AppState
    // still holds the stale proposal - the hook must drop it, reload and
    // toast exactly like a live save.
    render(<Probe />);
    await flushSave();
    expect(appState.hideProposal).toHaveBeenCalled();
    expect(appState.proposal).toBeUndefined();
    expect(appState.reload).toHaveBeenCalledTimes(1);
    expect(toastApi.show).toHaveBeenCalledWith({
      message: "Canvas updated with the Author's change.",
      tone: 'info',
    });
  });
});

describe('useAuthorCanvasSync saves', () => {
  it('reloads a clean document on an Author save and toasts', async () => {
    const { message } = proposeMessage('p_save');
    chatState.value = { messages: [message], active: null };
    render(<Probe />);
    await act(async () => {
      fireAgentSaved('a1');
    });
    await flushSave();
    expect(appState.reload).toHaveBeenCalledTimes(1);
    expect(appState.reload).toHaveBeenCalledWith();
    expect(appState.hideProposal).toHaveBeenCalled();
    expect(toastApi.show).toHaveBeenCalledWith({
      message: "Canvas updated with the Author's change.",
      tone: 'info',
    });
  });

  it('warns instead of claiming success when the agent cannot be reloaded', async () => {
    appState.reload.mockImplementation(async () => false);
    render(<Probe />);
    await act(async () => {
      fireAgentSaved('a1');
    });
    await flushSave();
    expect(toastApi.show).toHaveBeenCalledWith({
      message: 'The Author saved, but the canvas could not be reloaded.',
      tone: 'warning',
    });
  });

  it('ignores saves for other agents', async () => {
    render(<Probe />);
    await act(async () => {
      fireAgentSaved('other-agent');
    });
    await flushSave();
    expect(appState.reload).not.toHaveBeenCalled();
    expect(toastApi.show).not.toHaveBeenCalled();
  });

  it('ignores meta-only saves (setAgentEnabled) - the canvas spec did not change', async () => {
    render(<Probe />);
    await act(async () => {
      fireAgentSaved('a1', 'meta');
    });
    await flushSave();
    expect(appState.reload).not.toHaveBeenCalled();
    expect(toastApi.show).not.toHaveBeenCalled();
  });

  it('keeps local edits on a dirty document and offers Reload', async () => {
    appState.dirty = true;
    render(<Probe />);
    await act(async () => {
      fireAgentSaved('a1');
    });
    await flushSave();
    expect(appState.reload).not.toHaveBeenCalled();
    expect(appState.hideProposal).toHaveBeenCalled();
    expect(toastApi.show).toHaveBeenCalledTimes(1);
    const warning = toastApi.show.mock.calls[0][0] as {
      tone?: string;
      message?: string;
      action?: { label: string; onClick: () => void };
    };
    expect(warning.tone).toBe('warning');
    expect(warning.message).toContain('unsaved edits');
    expect(warning.action?.label).toBe('Reload');
    await act(async () => {
      warning.action?.onClick();
    });
    expect(appState.reload).toHaveBeenCalledWith({ discardLocal: true });
  });

  it('an agent switch mid-reload neither clobbers the new agent nor toasts', async () => {
    let resolveReload: ((ok: boolean) => void) | undefined;
    appState.reload.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReload = resolve;
        })
    );
    render(<Probe agentId="a1" />);
    await act(async () => {
      fireAgentSaved('a1');
    });
    // The fetch is still in flight when the user switches agents.
    rerender(<Probe agentId="a2" />);
    await act(async () => {
      resolveReload?.(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // reload() itself guards the document swap; the hook must also skip
    // the overlay clear and the "canvas updated" toast for the old agent.
    expect(toastApi.show).not.toHaveBeenCalled();
  });
});
