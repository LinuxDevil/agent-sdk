/**
 * Which proposal cards in an Author conversation are saved, discarded,
 * superseded or the one card whose Apply button is live (research §1.3).
 * The transcript is the proposal store, so the state is derived by walking
 * the settled messages then the active assistant message, in order - the
 * same walk a replayed session takes.
 *
 * An "ok part" is a tool part with `state === 'done'` and `output.ok ===
 * true`; anything else (busy, failed) moves nothing.
 */
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
} from '../../shared/authorWire';

/** Everything the proposal renderers need to pick each card's state. */
export interface ProposalActionState {
  /** The one card that gets Apply (the newest open proposal). */
  actionableProposalId: string | null;
  /** A requestSecret part is 'pending' (a client request waits on the user). */
  hasPendingClientRequest: boolean;
  /** The create cards that render; an unsaved create leaves the set when a newer one lands. */
  visibleCreateProposalIds: ReadonlySet<string>;
  savedProposalIds: ReadonlySet<string>;
  discardedProposalIds: ReadonlySet<string>;
}

/** What a proposal part contributes to the walk. */
interface TrackedProposal {
  kind: 'create' | 'update';
  agentId?: string;
}

/** The walk's mutable accumulator; returned as {@link ProposalActionState}. */
interface Walk {
  proposals: Map<string, TrackedProposal>;
  saved: Set<string>;
  discarded: Set<string>;
  visibleCreate: Set<string>;
  actionable: string | null;
  /** The newest create card not yet saved/discarded - the one a newer create supersedes. */
  openCreate: string | null;
  pendingClient: boolean;
}

function freshWalk(): Walk {
  return {
    proposals: new Map(),
    saved: new Set(),
    discarded: new Set(),
    visibleCreate: new Set(),
    actionable: null,
    openCreate: null,
    pendingClient: false,
  };
}

/** Whether a tool part settled successfully (`done` + `output.ok === true`). */
function okPart(part: AuthorToolPart): boolean {
  return (
    part.state === 'done' &&
    typeof part.output === 'object' &&
    part.output !== null &&
    (part.output as { ok?: unknown }).ok === true
  );
}

/** A proposal is unsaved while no save part, save uiEvent or discard has retired it. */
function unsaved(walk: Walk, proposalId: string): boolean {
  return !walk.saved.has(proposalId) && !walk.discarded.has(proposalId);
}

/** `ok` on `proposeAgent`: the newest open card, and the previous unsaved create stops rendering. */
function onProposeCreate(walk: Walk, id: string): void {
  if (walk.openCreate !== null) walk.visibleCreate.delete(walk.openCreate);
  walk.proposals.set(id, { kind: 'create' });
  walk.visibleCreate.add(id);
  walk.openCreate = id;
  walk.actionable = id;
}

/** `ok` on `proposeAgentUpdate`: the newest open card; older update cards stay visible as history. */
function onProposeUpdate(walk: Walk, id: string, output: unknown): void {
  const agentId = (output as { agentId?: unknown }).agentId;
  walk.proposals.set(id, {
    kind: 'update',
    ...(typeof agentId === 'string' ? { agentId } : {}),
  });
  walk.actionable = id;
}

/** `ok` on a save part: the open card it answers is saved. */
function onSavePart(walk: Walk): void {
  if (walk.actionable === null) return;
  walk.saved.add(walk.actionable);
  if (walk.openCreate === walk.actionable) walk.openCreate = null;
  walk.actionable = null;
}

/** `ok` on `discardPendingChanges`: every unsaved card of the identity (no `agentId` = creates). */
function onDiscardPart(walk: Walk, output: unknown): void {
  const agentId = (output as { agentId?: unknown }).agentId;
  const targetAgent = typeof agentId === 'string' ? agentId : undefined;
  for (const [id, tracked] of walk.proposals) {
    if (!unsaved(walk, id)) continue;
    const matches =
      targetAgent === undefined
        ? tracked.kind === 'create'
        : tracked.kind === 'update' && tracked.agentId === targetAgent;
    if (!matches) continue;
    walk.discarded.add(id);
    if (walk.openCreate === id) walk.openCreate = null;
    if (walk.actionable === id) walk.actionable = null;
  }
}

/** One assistant message's tool parts, in part order. */
function walkAssistant(walk: Walk, message: AuthorAssistantMessage): void {
  for (const part of message.parts) {
    if (part.type !== 'tool') continue;
    if (part.name === 'requestSecret' && part.state === 'pending') {
      walk.pendingClient = true;
      continue;
    }
    if (!okPart(part)) continue;
    if (part.name === 'proposeAgent') onProposeCreate(walk, part.toolCallId);
    else if (part.name === 'proposeAgentUpdate') onProposeUpdate(walk, part.toolCallId, part.output);
    else if (part.name === 'saveAgent' || part.name === 'saveAgentUpdate') onSavePart(walk);
    else if (part.name === 'discardPendingChanges') onDiscardPart(walk, part.output);
  }
}

/**
 * The proposal-card state of the whole conversation: walks `messages` then
 * the `active` assistant message (a live turn's settled parts count; its
 * busy parts move nothing). Each renderer calls this once per part - the
 * list is short and the walk is cheap.
 */
export function proposalActionState(
  messages: readonly AuthorMessage[],
  active?: AuthorAssistantMessage | null
): ProposalActionState {
  const walk = freshWalk();
  for (const message of messages) {
    if (message.role === 'assistant') {
      walkAssistant(walk, message);
    } else if (message.uiEvent?.kind === 'save') {
      const proposalId = message.uiEvent.proposalId;
      walk.saved.add(proposalId);
      if (walk.openCreate === proposalId) walk.openCreate = null;
      if (walk.actionable === proposalId) walk.actionable = null;
    }
  }
  if (active != null) walkAssistant(walk, active);
  return {
    actionableProposalId: walk.actionable,
    hasPendingClientRequest: walk.pendingClient,
    visibleCreateProposalIds: walk.visibleCreate,
    savedProposalIds: walk.saved,
    discardedProposalIds: walk.discarded,
  };
}

/** The four faces one card can wear: an open card, a saved one, a dropped one, or history. */
export type ProposalCardState = 'actionable' | 'saved' | 'discarded' | 'superseded';

/**
 * One card's state inside the walk: saved and discarded win over position,
 * then the single open card, then everything else is superseded history.
 */
export function cardState(proposalId: string, s: ProposalActionState): ProposalCardState {
  if (s.savedProposalIds.has(proposalId)) return 'saved';
  if (s.discardedProposalIds.has(proposalId)) return 'discarded';
  if (proposalId === s.actionableProposalId) return 'actionable';
  return 'superseded';
}
