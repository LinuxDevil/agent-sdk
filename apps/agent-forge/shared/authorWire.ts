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
