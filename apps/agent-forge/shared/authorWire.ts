/**
 * Agent Author wire types, shared by the Studio server
 * (`server/author/**`) and the browser client (the Author panel talks to
 * `POST/GET/DELETE /assistant/sessions`).
 *
 * An Author chat session is the proposal store: every proposal card the
 * Author shows lives in the persisted transcript, so the shapes the
 * session file uses are fixed here once - server and client import this
 * module instead of re-declaring them.
 */

// The readiness row AA13's `computeRequirements` returns and the Author's
// proposal cards carry: defined next to `RequirementKind` in wireTypes.ts
// (where `AgentRecord.requirements` reads it), re-exported here so Author
// code has one import site per the PLAN §8.5 contract.
export type { Requirement } from './wireTypes';

/** What the Author is working on this session. */
export type AuthorFocus = { mode: 'create' } | { mode: 'edit'; agentId: string };

/** App-written events stored as user messages (never typed by the user). */
export type AuthorUiEvent =
  | { kind: 'save'; proposalId: string; agentId: string; version: number }
  | { kind: 'secret'; toolCallId: string; name: string; outcome: 'saved' | 'declined' };

/** A user-authored transcript entry (or an app-written `uiEvent`). */
export interface AuthorUserMessage {
  id: string; // 'm_' + crypto.randomUUID()
  role: 'user';
  text: string; // '' for uiEvent-only messages
  at: string; // ISO
  turnContext?: string; // the exact context block sent with this message (replayed verbatim)
  uiEvent?: AuthorUiEvent;
}

/** One text chunk of an assistant turn. */
export interface AuthorTextPart {
  type: 'text';
  text: string;
}

/** One tool call of an assistant turn, output filled in when it settles. */
export interface AuthorToolPart {
  type: 'tool';
  toolCallId: string;
  name: string;
  input: unknown;
  output?: unknown;
  state: 'done' | 'error' | 'pending';
}

/** An assistant transcript entry: the ordered parts of one turn. */
export interface AuthorAssistantMessage {
  id: string;
  role: 'assistant';
  parts: Array<AuthorTextPart | AuthorToolPart>;
  at: string;
  requestId?: string; // the turn that produced it
  finishReason?: string; // copied from run.done, or 'stopped' | 'error' | 'tool_input_cap'
}

/** Any persisted transcript entry. */
export type AuthorMessage = AuthorUserMessage | AuthorAssistantMessage;

/**
 * One Author chat session, stored as `<sessionsDir>/<id>.json`
 * (Studio-global - `studioPaths().sessions`). `workspaceId` records which
 * workspace the chat edits agents in: later Author code resolves agent
 * stores from it through the app's WorkspaceResolver, never from a
 * closed-over repo.
 */
export interface AuthorSession {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  focus: AuthorFocus;
  transcript: AuthorMessage[];
  createdAgentIds: string[];
}

/** The `GET /assistant/sessions` row: a session without its transcript. */
export interface AuthorSessionSummary {
  id: string;
  title: string;
  focus: AuthorFocus;
  workspaceId: string;
  updatedAt: string;
  messageCount: number;
  createdAgentIds: string[];
}

/**
 * Every `:id` the Author routes take ends up in a filename under the
 * sessions directory. Validated on every route and again inside the store
 * before any path join, so a decoded `..`/`/`/overlong id is a 400 and
 * never reaches the filesystem. `isValidAgentId` is NOT used here: it
 * allows `.`, which `..` needs.
 */
export const AUTHOR_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A session's title until the first user text gives it a real one. */
export const DEFAULT_SESSION_TITLE = 'New chat';

/**
 * Every failure code an Author tool may return (PLAN §8.3). The union is
 * the whole P5 contract up front - AA06's read tools use a few of them,
 * later tickets (propose, save, secrets, runs) use the rest, and nobody
 * extends it silently: a new refusal mode is a plan change, not a code
 * change.
 */
export type AuthorFailureCode =
  | 'INVALID_INPUT' | 'AGENT_NOT_FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | 'TIMEOUT' | 'MCP_PROBE_FAILED'
  | 'DRAFT_INVALID' | 'UNKNOWN_MODEL' | 'UNKNOWN_TOOL' | 'UNKNOWN_GUARDRAIL' | 'UNKNOWN_TRIGGER_TYPE' | 'UNKNOWN_AGENT_REF'
  | 'EDITS_AND_INSTRUCTIONS' | 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS' | 'ANCHOR_OVERLAP' | 'INSTRUCTIONS_IN_FILE' | 'EMPTY_PATCH'
  | 'DRAFT_REVIEW'
  | 'UNANSWERED' | 'NO_PROPOSAL' | 'ALREADY_SAVED' | 'UNKNOWN_PROPOSAL' | 'STALE_PROPOSAL' | 'WRONG_AGENT'
  | 'AMBIGUOUS_PROPOSAL' | 'INVALID_STORED_PROPOSAL' | 'BASE_CHANGED' | 'AGENT_GONE' | 'WRITE_FAILED' | 'BUSY'
  | 'SECRET_EXISTS' | 'DECLINED' | 'RUN_BUSY' | 'RUN_FAILED' | 'TRACE_NOT_FOUND';

/**
 * The failure every Author tool returns instead of throwing (research
 * §4: "failures are returned, never thrown"). `error` is model-facing -
 * precisely what went wrong; `userMessage` is person-facing - plain
 * words, no tool names or ids; `next` tells the model what to do now.
 * Extra keys carry failure-specific detail (a patch failure's anchors, a
 * save failure's latest proposal id).
 */
export interface AuthorToolFailure {
  ok: false;
  code: AuthorFailureCode;
  /** For the model: what went wrong, precisely. */
  error: string;
  /** For the person: plain words, no tool names or ids. */
  userMessage: string;
  /** For the model: what to do now. */
  next?: string;
  [extra: string]: unknown;
}

/**
 * Every event one Author turn produces, in order. `AuthorTurnRunner`
 * emits them on its `'event'` channel as `(sessionId, event)`; the
 * WebSocket transport forwards them verbatim. `seq` is per-turn monotone
 * (1 = `turn.started`) so a client that resumes mid-turn can drop
 * duplicates it already rendered. `requestId` ties every event to the
 * `chat.send` the client sent.
 */
export type AuthorServerEvent =
  | { type: 'turn.started'; requestId: string; seq: number }
  | { type: 'text.delta'; requestId: string; seq: number; text: string }
  | { type: 'tool.call'; requestId: string; seq: number; toolCallId: string; name: string; input: unknown }
  | { type: 'tool.result'; requestId: string; seq: number; toolCallId: string; name: string; output: unknown; state: 'done' | 'error' }
  | { type: 'tool.pending'; requestId: string; seq: number; toolCallId: string; name: string; input: unknown }
  | { type: 'turn.finished'; requestId: string; seq: number; finishReason: string }
  | { type: 'turn.error'; requestId: string; seq: number; message: string; code?: string };

/**
 * The Agent Author's model choices (the Settings "Agent Author" card):
 * `model` runs the chat turns, `reviewModel` the draft-review pass -
 * both `provider/model` ids. `reviewEnabled` gates the review pass.
 */
export interface AuthorSettings {
  model: string;
  reviewModel: string;
  reviewEnabled: boolean;
}

/**
 * `GET`/`PUT /settings/author`'s response: the effective settings plus
 * whether the configured Author model can run right now (`ready`) and,
 * when it cannot, which provider the missing key belongs to
 * (`missingKeyFor`) so the client can point at the right Settings field.
 */
export interface AuthorSettingsPayload extends AuthorSettings {
  ready: boolean;
  missingKeyFor?: string;
}
