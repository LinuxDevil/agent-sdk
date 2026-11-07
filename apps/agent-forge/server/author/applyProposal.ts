/**
 * The card's Apply button write path (PLAN §8.3): resolves the stored
 * proposal the click names, writes exactly its spec through the same
 * `writeProposal` the save tools use - the click is the confirmation, so
 * the model's blocking gate does not apply - then appends the
 * `uiEvent: save` user message the model reads as "[UI event] User
 * applied proposal <id>" next turn.
 *
 * Extracted from `POST /assistant/sessions/:id/save` so the eval harness
 * (AA21) presses Apply through the production path rather than a copy:
 * the route keeps the HTTP concerns (id/body validation, the busy and
 * in-flight guards) and delegates the rest here.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuthorFailureCode,
  AuthorSaveResponse,
  AuthorSession,
  AuthorUserMessage,
} from '../../shared/authorWire';
import type { WorkspaceResolver } from '../workspace/context';
import { identityOfProposal, resolveStoredProposal } from './proposal/gate';
import { agentGoneFailure, unknownProposalFailure } from './proposal/failures';
import { requestTextFor, writeProposal } from './proposal/save';
import type { AuthorSessionStore } from './sessionStore';

/** The stores Apply needs: the session store (transcript + createdAgentIds) and the session's workspace. */
export interface ApplyProposalDeps {
  sessions: AuthorSessionStore;
  workspaceResolver: WorkspaceResolver;
}

/**
 * Apply's outcome: the 200 body on success (the saved agent plus the
 * appended `uiEvent` user message), or the failure the route renders as
 * an error response - `status` mirrors `sendSaveFailure` (`WRITE_FAILED`
 * is a 500, every refusal a 400).
 */
export type ApplyProposalOutcome =
  | { ok: true; response: AuthorSaveResponse }
  | {
      ok: false;
      status: 400 | 500;
      userMessage: string;
      code: AuthorFailureCode;
      details?: { latestProposalId: string };
    };

function failure(code: AuthorFailureCode, userMessage: string, details?: { latestProposalId: string }): ApplyProposalOutcome {
  return { ok: false, status: code === 'WRITE_FAILED' ? 500 : 400, userMessage, code, ...(details && { details }) };
}

/**
 * Writes the stored card `proposalId` names, exactly as shown. `session`
 * is the already-loaded session record; concurrency guards (a running
 * turn, a racing Apply) belong to the caller - the route holds
 * `savesInFlight`, the eval harness applies only between turns.
 */
export async function applyStoredProposal(
  deps: ApplyProposalDeps,
  session: AuthorSession,
  proposalId: string
): Promise<ApplyProposalOutcome> {
  const identity = identityOfProposal(session.transcript, proposalId);
  if (identity === null) {
    const unknown = unknownProposalFailure('create', proposalId);
    return failure(unknown.code, unknown.userMessage);
  }
  const ws = await deps.workspaceResolver.resolve(session.workspaceId);
  if (ws === undefined) {
    const gone = agentGoneFailure(identity.kind === 'update' ? identity.agentId : session.workspaceId);
    return failure(gone.code, gone.userMessage);
  }
  const resolved = resolveStoredProposal(session.transcript, identity, proposalId);
  if (!resolved.ok) {
    const details =
      typeof resolved.latestProposalId === 'string' ? { latestProposalId: resolved.latestProposalId } : undefined;
    return failure(resolved.code, resolved.userMessage, details);
  }
  const result = await writeProposal(identity, resolved.output, {
    sessionId: session.id,
    requestText: requestTextFor(session.transcript, proposalId),
    agents: ws.repo,
    versions: ws.versions,
    sessions: deps.sessions,
    bus: ws.events,
  });
  if (!result.ok) {
    const details =
      typeof result.latestProposalId === 'string' ? { latestProposalId: result.latestProposalId } : undefined;
    return failure(result.code, result.userMessage, details);
  }
  const message: AuthorUserMessage = {
    id: `m_${randomUUID()}`,
    role: 'user',
    text: '',
    at: new Date().toISOString(),
    uiEvent: { kind: 'save', proposalId, agentId: result.agentId, version: result.version },
  };
  await deps.sessions.update(session.id, (s) => ({ ...s, transcript: [...s.transcript, message] }));
  return {
    ok: true,
    response: {
      ok: true,
      agentId: result.agentId,
      version: result.version,
      name: result.name,
      enabled: result.enabled,
      message,
    },
  };
}
