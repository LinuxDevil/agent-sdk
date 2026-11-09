/**
 * AA18 - canvas sync for the Agent Author. While the conversation's one
 * actionable card is an update for the agent on screen, its spec rides
 * C21's proposal overlay (added/edited/removed nodes drawn dashed) on top
 * of the untouched canvas graph - nothing is written until the user
 * applies the card. An Author-driven save (`onAgentSaved`, AA15a) then
 * reloads the document from disk; with unsaved local edits it keeps them,
 * clears the overlay and offers a Reload that discards them instead.
 *
 * Mounted once by the builder screen (`AgentsScreen`) with the agent on
 * screen. Create cards never draw an overlay - there is no canvas agent
 * to diff against yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  ProposalOutput,
} from '../../shared/authorWire';
import { useAppState } from '../state/AppState';
import { useToast } from '../ui/Toast';
import { useAuthorChat } from './AuthorChatContext';
import { onAgentSaved } from './authorEvents';
import { proposalActionState, type ProposalActionState } from './proposalActionState';
import { findProposalOutput } from './savedProposal';

/**
 * The open update card for `agentId`, or null: the actionable card when
 * it is an update for this agent. Create cards and updates for other
 * agents return null - neither has a canvas diff to draw.
 */
export function openCardForAgent(
  state: ProposalActionState,
  messages: readonly AuthorMessage[],
  active: AuthorAssistantMessage | null,
  agentId: string
): ProposalOutput | null {
  const proposalId = state.actionableProposalId;
  if (proposalId === null) return null;
  const output = findProposalOutput(messages, active, proposalId);
  if (output === null || output.kind !== 'update' || output.agentId !== agentId) return null;
  return output;
}

/** Canonical-ish JSON for the overlay's change key - spec objects are small and already memoised upstream. */
function specHash(spec: unknown): string {
  return JSON.stringify(spec) ?? '';
}

/**
 * Mount once in the canvas screen. `agentId` is the agent on screen.
 * Returns the shown proposal's id (for the toolbar pill) or null.
 */
export function useAuthorCanvasSync(agentId: string): { overlayProposalId: string | null } {
  const { spec, showProposal, hideProposal, dirty, reload } = useAppState();
  const { state: chatState } = useAuthorChat();
  const toast = useToast();
  const [overlayProposalId, setOverlayProposalId] = useState<string | null>(null);
  // The key of the overlay this hook last put up (`proposalId` + the doc
  // spec hash + the card spec hash): a stream frame that changes neither
  // never re-calls the setter, so `mergeProposal` does not rerun.
  const shownKeyRef = useRef<string | null>(null);
  // The save listener outlives renders; `dirty` is read through a ref so
  // the subscription does not churn on every edit.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const messages = chatState.messages;
  const active = chatState.active?.assistant ?? null;
  const actionState = useMemo(() => proposalActionState(messages, active), [messages, active]);
  const card = useMemo(
    () => openCardForAgent(actionState, messages, active, agentId),
    [actionState, messages, active, agentId]
  );
  const docSpecHash = useMemo(() => specHash(spec), [spec]);
  const cardSpecHash = useMemo(() => (card === null ? '' : specHash(card.spec)), [card]);

  const clearOverlay = useCallback(() => {
    shownKeyRef.current = null;
    setOverlayProposalId(null);
    hideProposal();
  }, [hideProposal]);

  // The overlay follows the open card: show it while a card for this
  // agent is actionable, clear it when the card is saved, discarded,
  // superseded or the screen switched to another agent.
  useEffect(() => {
    if (card === null) {
      if (shownKeyRef.current !== null) {
        shownKeyRef.current = null;
        setOverlayProposalId(null);
        hideProposal();
      }
      return;
    }
    const key = `${card.proposalId}\n${docSpecHash}\n${cardSpecHash}`;
    if (shownKeyRef.current === key) return;
    shownKeyRef.current = key;
    showProposal({ proposalId: card.proposalId, spec: card.spec });
    setOverlayProposalId(card.proposalId);
  }, [card, docSpecHash, cardSpecHash, showProposal, hideProposal]);

  // An Author save for the agent on screen: reload the canvas from disk
  // (keeping local edits would just be overwritten, so a dirty document
  // keeps them and gets a Reload offer instead).
  useEffect(() => {
    return onAgentSaved((savedId) => {
      if (savedId !== agentId) return;
      void (async () => {
        if (!dirtyRef.current) {
          try {
            await reload();
          } catch {
            toast.show({ message: 'The Author saved, but the canvas could not be reloaded.', tone: 'error' });
            return;
          }
          clearOverlay();
          toast.show({ message: "Canvas updated with the Author's change.", tone: 'info' });
          return;
        }
        clearOverlay();
        toast.show({
          message:
            'The Author saved a new version, but you have unsaved edits here. Save or undo them, then reload.',
          tone: 'warning',
          action: {
            label: 'Reload',
            onClick: () => {
              void reload({ discardLocal: true }).catch(() => {
                toast.show({ message: 'The canvas could not be reloaded.', tone: 'error' });
              });
            },
          },
        });
      })();
    });
  }, [agentId, reload, toast, clearOverlay]);

  return { overlayProposalId };
}
