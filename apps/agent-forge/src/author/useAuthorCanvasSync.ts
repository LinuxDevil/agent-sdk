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
 * screen - but the Author dock is app-global, so the screen unmounts on
 * other routes while saves keep landing. Two module-level records cover
 * that gap: `syncedProposalIds` remembers which overlays this sync put up
 * (a remount drops a stale one whose card is gone), and `savedWhileAway`
 * remembers spec saves that arrived unmounted (the next mount of that
 * agent's canvas honours them). A permanent `onAgentSaved` listener,
 * registered at module load, feeds `savedWhileAway`; the per-mount
 * listener handles saves live and consumes its own entries.
 *
 * Create cards never draw an overlay - there is no canvas agent to diff
 * against yet.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  ProposalOutput,
} from '../../shared/authorWire';
import { useAppState } from '../state/AppState';
import { useToast, type ToastApi } from '../ui/Toast';
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

/** Proposal ids this sync has shown on the canvas - survives unmount so a stale overlay is recognised on remount. */
const syncedProposalIds = new Set<string>();

/** Agent ids the Author spec-saved while their canvas screen was not mounted - honoured on next mount. */
const savedWhileAway = new Set<string>();

// The Author dock is app-global but the canvas screen is not: this
// listener lives for the app's lifetime so a save that lands while no
// canvas is mounted is still recorded for the next mount. `'meta'`
// changes (setAgentEnabled) never touch the canvas and are not tracked.
onAgentSaved((id, change) => {
  if (change !== 'meta') savedWhileAway.add(id);
});

/**
 * The open update card for `agentId` plus the two spec hashes that key the
 * overlay effect (`docSpecHash` on the live document, `cardSpecHash` on
 * the card): a stream frame that changes neither never re-runs it.
 */
function useOpenCard(
  agentId: string,
  spec: unknown
): { card: ProposalOutput | null; docSpecHash: string; cardSpecHash: string } {
  const { state: chatState } = useAuthorChat();
  const messages = chatState.messages;
  const active = chatState.active?.assistant ?? null;
  const actionState = useMemo(() => proposalActionState(messages, active), [messages, active]);
  const card = useMemo(
    () => openCardForAgent(actionState, messages, active, agentId),
    [actionState, messages, active, agentId]
  );
  const docSpecHash = useMemo(() => specHash(spec), [spec]);
  const cardSpecHash = useMemo(() => (card === null ? '' : specHash(card.spec)), [card]);
  return { card, docSpecHash, cardSpecHash };
}

/** `reload` from AppState: resolves false when the document could not be reloaded. */
type ReloadAgent = (options?: { discardLocal?: boolean }) => Promise<boolean>;

/**
 * The dirty-document branch of an Author save: the canvas keeps its local
 * edits, warns, and offers a Reload action that discards them. The toast
 * outlives an agent switch: it only reloads while the canvas still shows
 * the agent the save was for (`agentIdRef` re-resolves at click time).
 */
function showDirtySaveToast(
  toast: ToastApi,
  forAgent: string,
  agentIdRef: { readonly current: string },
  reloadRef: { readonly current: ReloadAgent }
): void {
  toast.show({
    message:
      'The Author saved a new version, but you have unsaved edits here. Save or undo them, then reload.',
    tone: 'warning',
    action: {
      label: 'Reload',
      onClick: () => {
        if (agentIdRef.current !== forAgent) return;
        void reloadRef
          .current({ discardLocal: true })
          .then((ok) => {
            if (ok === false) {
              toast.show({ message: 'The canvas could not be reloaded.', tone: 'warning' });
            }
          })
          .catch(() => {
            toast.show({ message: 'The canvas could not be reloaded.', tone: 'error' });
          });
      },
    },
  });
}

/**
 * The save half of the sync: an Author spec-save for the agent on screen
 * reloads the canvas from disk - a dirty document keeps its edits and gets
 * a Reload offer instead. Live saves plus the mount-time drain of
 * `savedWhileAway`: a spec save that landed while this screen was
 * unmounted is honoured now, same as a live one. Everything re-resolves
 * through refs at call time, so an agent switch mid-flight or a stale
 * toast action can never write the old agent back over the new one.
 */
function useAuthorSavedSync(agentId: string, clearOverlay: () => void): void {
  const { dirty, reload } = useAppState();
  const toast = useToast();
  // Latest-value refs: the listener, the Reload toast action and the
  // mount-time drain all outlive the render (and possibly the agent) they
  // were created in, so they re-resolve at call time.
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const handleSaved = useCallback(
    (savedId: string) => {
      if (savedId !== agentIdRef.current) return;
      savedWhileAway.delete(savedId);
      const forAgent = savedId;
      void (async () => {
        if (dirtyRef.current) {
          clearOverlay();
          showDirtySaveToast(toast, forAgent, agentIdRef, reloadRef);
          return;
        }
        let reloaded = false;
        try {
          reloaded = await reloadRef.current();
        } catch {
          reloaded = false;
        }
        // The screen moved to another agent while the fetch ran: the
        // reload itself already refused to clobber it, and neither the
        // overlay clear nor the toast applies here anymore.
        if (agentIdRef.current !== forAgent) return;
        clearOverlay();
        toast.show(
          reloaded
            ? { message: "Canvas updated with the Author's change.", tone: 'info' }
            : { message: 'The Author saved, but the canvas could not be reloaded.', tone: 'warning' }
        );
      })();
    },
    [toast, clearOverlay]
  );

  useEffect(() => {
    const off = onAgentSaved((id, change) => {
      if (change !== 'meta') handleSaved(id);
    });
    if (savedWhileAway.delete(agentId)) handleSaved(agentId);
    return off;
  }, [agentId, handleSaved]);
}

/**
 * Mount once in the canvas screen. `agentId` is the agent on screen.
 * Returns the proposal id actually overlaying the canvas (for the toolbar
 * pill) or null - read off `AppState.proposal`, the single source of
 * truth, so an external `hideProposal` (banner Hide, agent mutations)
 * can never leave the pill showing a phantom overlay.
 */
export function useAuthorCanvasSync(agentId: string): { overlayProposalId: string | null } {
  const { spec, proposal, showProposal, hideProposal } = useAppState();
  // The key of the overlay this hook last put up (`proposalId` + the doc
  // spec hash + the card spec hash): a stream frame that changes neither
  // never re-calls the setter, so `mergeProposal` does not rerun.
  const shownKeyRef = useRef<string | null>(null);
  const { card, docSpecHash, cardSpecHash } = useOpenCard(agentId, spec);

  // The overlay follows the open card: show it while a card for this
  // agent is actionable, and let it come down when the card is saved,
  // discarded, superseded or the screen switched to another agent. An
  // overlay this sync did not put up (the dev `__forgeShowProposal`
  // trigger) is never touched.
  useEffect(() => {
    if (card === null) {
      if (proposal !== undefined && syncedProposalIds.has(proposal.proposalId)) {
        syncedProposalIds.delete(proposal.proposalId);
        shownKeyRef.current = null;
        hideProposal();
      }
      return;
    }
    const key = `${card.proposalId}\n${docSpecHash}\n${cardSpecHash}`;
    // Re-show when the overlay was cleared from outside (banner Hide, an
    // agent mutation's `agentActionsClearing`) while the card stays
    // actionable - `shownKeyRef` alone must not block it.
    if (shownKeyRef.current === key && proposal?.proposalId === card.proposalId) return;
    shownKeyRef.current = key;
    syncedProposalIds.add(card.proposalId);
    showProposal({ proposalId: card.proposalId, spec: card.spec });
  }, [card, docSpecHash, cardSpecHash, proposal, showProposal, hideProposal]);

  const clearOverlay = useCallback(() => {
    shownKeyRef.current = null;
    syncedProposalIds.clear();
    hideProposal();
  }, [hideProposal]);

  useAuthorSavedSync(agentId, clearOverlay);

  // The shown proposal id, derived from AppState.proposal and gated on
  // the card still being the open one - the toolbar pill's source.
  const overlayProposalId = card !== null && proposal?.proposalId === card.proposalId ? card.proposalId : null;

  return { overlayProposalId };
}
