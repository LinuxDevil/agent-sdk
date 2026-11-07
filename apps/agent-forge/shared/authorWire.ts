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

import type { AgentSpecV2 } from 'lousho';
import type { Requirement, SpecChange } from './wireTypes';

// The readiness row AA13's `computeRequirements` returns and the Author's
// proposal cards carry: defined next to `RequirementKind` in wireTypes.ts
// (where `AgentRecord.requirements` reads it), re-exported here so Author
// code has one import site per the PLAN §8.5 contract.
export type { Requirement } from './wireTypes';

// The diff rows a proposal card for an UPDATE renders: D10's `diffSpecs`
// output type, re-exported for the same one-import-site reason.
export type { SpecChange } from './wireTypes';

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

/**
 * `GET /assistant/sessions/:id`'s response: the stored session plus the
 * requestId of its running turn, when one is in flight (from
 * `AuthorTurnRunner.running`). A client that (re)opens a chat uses it to
 * decide whether to send `chat.resume` for the in-flight reply.
 */
export interface AuthorSessionRecord extends AuthorSession {
  runningRequestId: string | null;
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

/** The exact pathname the Author chat's WebSocket lives on (`WS /assistant/stream?session=<id>`). */
export const AUTHOR_STREAM_PATH = '/assistant/stream';

/**
 * Everything a client may send on `WS /assistant/stream`. `chat.send`
 * starts a turn (the `requestId` ties its events back to this send),
 * `chat.stop` ends the running turn early, and `chat.resume` reattaches a
 * dropped client to its turn: `afterSeq` is the last seq the client
 * applied (omitted = replay everything still buffered). The server
 * answers from the replay buffer - the missed events while the turn
 * still runs, only the terminal event once it settled, or an
 * `UNKNOWN_REQUEST` `turn.error` for a requestId it never saw.
 */
export type AuthorClientMessage =
  | { type: 'chat.send'; requestId: string; text: string; focus?: AuthorFocus }
  | { type: 'chat.stop'; requestId: string }
  | { type: 'chat.resume'; requestId: string; afterSeq?: number };

/** Whether a proposal card creates a new agent or updates an existing one. */
export type ProposalKind = 'create' | 'update';

/**
 * `POST /assistant/sessions/:id/save`'s 200 body (the card's Apply
 * button): the saved agent's id, version, name and enabled state, plus
 * the `uiEvent` user message the route appended to the transcript - the
 * client renders it so its local transcript matches the stored one.
 */
export interface AuthorSaveResponse {
  ok: true;
  agentId: string;
  version: number;
  name: string;
  enabled: boolean;
  /** The user message appended to the transcript (`uiEvent: { kind: 'save', ... }`). */
  message: AuthorUserMessage;
}

/**
 * The `ok: true` output of `setAgentEnabled` and of
 * `POST /assistant/sessions/:id/enable` (the SuccessCard's "Enable agent"
 * button - both go through the same write, AA11). `status` distinguishes
 * a real flip from a no-op, and `missingRequirements` is the count of the
 * agent's readiness rows still `status: 'missing'` - the switch lands
 * either way; the number exists so the model (and the card) can mention
 * what the agent still needs before it can run.
 */
export interface SetEnabledOutput {
  ok: true;
  agentId: string;
  enabled: boolean;
  status: 'updated' | 'unchanged';
  missingRequirements: number;
}

/**
 * The `ok: true` output of `proposeAgent`/`proposeAgentUpdate` - the card
 * the Author panel renders (PLAN §8.3). `proposalId` is the propose call's
 * `toolCallId`: the transcript is the proposal store, so nothing is
 * written anywhere else. `spec` is exactly what a save would write;
 * `changes` is the diff a card shows for an update (`[]` for a create,
 * which shows the full config); `requirements` is the advisory readiness
 * list. `carriedOver`/`carriedFields` report an update that folded an
 * earlier unapplied card (AA09; always false/[] for creates),
 * `baseSpecHash` pins the saved spec an update patched, and `enabled` is
 * the agent's current switch state (`false` for creates: a new agent
 * saves disabled).
 */
export interface ProposalOutput {
  ok: true;
  /** The propose call's `toolCallId` - the card's id in the transcript. */
  proposalId: string;
  kind: ProposalKind;
  /** Set on updates only: the agent the patch applies to. */
  agentId?: string;
  /** The complete spec a save would write. */
  spec: AgentSpecV2;
  /** The update diff; `[]` for creates (the card shows the full config instead). */
  changes: SpecChange[];
  /** The spec's readiness rows (`computeRequirements`, AA13) - advisory, never a block. */
  requirements: Requirement[];
  /** Whether an earlier unapplied card for the same agent was folded in (AA09). */
  carriedOver: boolean;
  /** The fields an earlier folded card contributed (AA09); `[]` for creates. */
  carriedFields: string[];
  /** Updates: `specHash` of the saved spec the patch applied to; creates: `null`. */
  baseSpecHash: string | null;
  /** Creates: `false`; updates: the agent's `meta.enabled`. */
  enabled: boolean;
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
