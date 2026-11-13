/**
 * Runtime control server - shared wire types.
 *
 * Single source of truth for the shapes exchanged between the server
 * (apps/agent-forge/server/**) and the browser client
 * (src/runtime/runtimeClient.ts); both import this module.
 *
 * The server holds an in-memory registry mapping agent IDs to live
 * `AgentExecutor.execute()` invocations (see runRegistry.ts). This file
 * defines the wire shape of the status/events the server reports back to
 * the app over `GET /agents/:id/status` and `WS /agents/:id/stream`.
 */
import type {
  AgentEventUsage,
  AgentSpecV2,
  CheckpointStatus,
  TrajectoryComparison,
  TrajectoryStep,
  listBuiltinTools,
  listGuardrails,
  listModels,
  listTriggerTypes,
} from 'lousho';
import type { WorkspaceRef } from './workspace';
import type { AuthorSettings } from './authorWire';

/**
 * Status pill states the app's agent list / topbar render (as in the
 * mockup: running/stopped/error/paused).
 * `done` is a run that finished on its own; `stopped` is one the
 * user stopped (`POST /agents/:id/stop`).
 */
export type RunStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error' | 'paused';

/**
 * A pause an in-progress run is waiting on a human for - a tool-call
 * decision or an `ask_question` answer - resolved via
 * `POST /agents/:id/approve`. Mirrors the subset of
 * `PendingApproval` (src/execution/ApprovalGate.ts) the UI needs to render
 * its inline card, without leaking the full ExecutionSnapshot.
 */
export interface PendingApprovalInfo {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
  /**
   * What the pause asks for, always set so the client never guesses:
   * 'tool' for an approve/reject decision (a 'sign-in' pause stays 'tool'),
   * 'question' for an `ask_question` call awaiting an answer.
   */
  kind: 'tool' | 'question';
  /** The question an `ask_question` pause asks (the SDK's `ApprovalQuestion`); set only when `kind` is 'question'. */
  question?: { text: string; options?: string[]; allowFreeText?: boolean };
  /** ISO instant Studio resolves the pause itself (nobody answered/decided) - the countdown's target. */
  deadline: string;
  /** The sub-agent chain the paused call belongs to, outermost first; absent for the top-level agent's own calls. */
  subagentPath?: string[];
}

/**
 * `POST /agents/:id/approve`'s body: a decision for a `kind: 'tool'`
 * pause, or the answer to a `kind: 'question'` pause (1..4000 chars).
 * Sending one shape to the other kind is a 400 `LOUSHO_APPROVAL_KIND`.
 */
export type ApproveRequest =
  | { approvalId: string; approved: boolean; note?: string }
  | { approvalId: string; answer: string };

/**
 * The full status record the server keeps per agent ID and reports back to
 * the client (REST snapshot + WS push).
 */
export interface AgentRunStatusPayload {
  agentId: string;
  status: RunStatus;
  sessionId?: string;
  /** Set when status === 'paused' because of a pending tool approval. */
  reason?: 'awaiting_approval';
  pendingApproval?: PendingApprovalInfo;
  /** Set when status === 'error'. */
  error?: string;
  /** Final assistant text, once a run completes successfully. */
  resultText?: string;
  /**
   * The full `ExecutionResult` (src/execution/AgentExecutor.ts -
   * `messages`/`toolCalls`/`usage`/`steps`/`finishReason`, not just the
   * final text) once a run completes OR pauses for approval - the Output
   * tab's JSON tree source. `unknown` here (rather than importing
   * `ExecutionResult`) since this module is also used client-side
   * (src/runtime/runtimeClient.ts) where it's rendered generically.
   */
  result?: unknown;
  /** `<provider>/<model>` the latest run actually used (e.g. `openai/gpt-4o-mini`, `mock/mock-1`). */
  provider?: string;
  /** Trace id (root span id) of the latest run, once its first span started - the top bar's "Open trace" link. */
  traceId?: string;
  /**
   * Why the run was cancelled - set when `status === 'stopped'` (`'user'` for
   * a Stop click, `'abort_listener:<id>'` for an abort listener, any other
   * caller-supplied reason). Cleared when the next run launches.
   */
  abortReason?: string;
  /**
   * This run's steer messages (`POST /agents/:id/steer`), oldest first -
   * each one's delivery flips queued -> delivered/undelivered as the run
   * consumes it or ends. Reset to `[]` when the next run launches; the
   * last run's list stays on the status after it settles so the Test
   * pane can keep showing it.
   */
  steering?: SteerInfo[];
  /**
   * What started this run (L12): `'trigger'` for runs a trigger launched
   * (`triggerId` names which), `'manual'`/absent for Run/chat starts. Set
   * on launch and kept through approve()/resume of the same run; cleared
   * by the next manual run. The failure-streak pass counts only
   * `'trigger'` runs.
   */
  source?: 'manual' | 'trigger';
  triggerId?: string;
  updatedAt: string;
}

/** `POST /agents/:id/abort` body (the body itself is optional). */
export interface AbortRunRequest {
  /**
   * Why the run is being cancelled: 1..200 characters, defaulting to `'user'`.
   * Abort listeners pass `'abort_listener:<id>'` (PLAN §10).
   */
  reason?: string;
}

/** How far a steered message got: still waiting, joined the transcript, or the run ended first. */
export type SteerDelivery = 'queued' | 'delivered' | 'undelivered';

/** One `POST /agents/:id/steer` message and its delivery state, as `AgentRunStatusPayload.steering` carries it. */
export interface SteerInfo {
  id: string;
  message: string;
  at: string;
  delivery: SteerDelivery;
  /** How `AgentRun.steer()` took it: aborted the in-flight model call, or waits for the next safe point. */
  mode: 'immediate' | 'queued';
}

/** `POST /agents/:id/steer` request body - `message` is 1..3000 chars after trim. */
export interface SteerRequest {
  message: string;
}

/** `POST /agents/:id/steer` 202 response. */
export interface SteerResponse {
  id: string;
  applied: 'immediate' | 'queued';
}

/**
 * Structured log line severity, shown in the Logs tab's filter bar.
 * `tool` is its own level (not folded into `info`) so the filter bar can
 * isolate tool activity the way the mockup's log rows do.
 */
export type LogLevel = 'info' | 'warn' | 'error' | 'tool';

/**
 * Which part of the run a log line came from - reuses the same
 * taxonomy the mockup's log rows are tagged with. Derived from
 * `AgentEvent.type` (see logEntries.ts's `toLogEntries()`), extended
 * with 'sandbox'/'checkpoint'/'debug' for events the AgentEvent
 * stream doesn't carry a dedicated type for.
 */
export type LogPhase = 'trigger' | 'llm' | 'tool' | 'sandbox' | 'checkpoint' | 'approval' | 'debug';

export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: string;
  level: LogLevel;
  phase: LogPhase;
  /** Tool name, when `phase === 'tool'`. */
  toolName?: string;
  message: string;
  detail?: unknown;
}

/**
 * One span lifecycle notification, forwarded verbatim (real
 * `Date.now()` timestamps, not synthetic ones) from the SDK's
 * `TraceExporter.onSpanStart`/`onSpanEnd` (src/execution/tracing.ts).
 */
export interface SpanEvent {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  /** `internal` or `client` (a model call). */
  kind?: 'internal' | 'client';
  /** `error` when the span failed. */
  status?: { code: 'ok' | 'error'; message?: string };
}

/** One persisted run in `GET /agents/:id/traces` (the SDK's `TraceSummary` without the server-side file path). */
export interface TraceSummaryPayload {
  traceId: string;
  name: string;
  agent?: string;
  startTime: number;
  durationMs: number;
  status: 'ok' | 'error';
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** `GET /agents/:id/traces/:traceId`. */
export interface TraceDetailPayload {
  traceId: string;
  spans: SpanEvent[];
}

/**
 * Live step-through debugger state for one agent's run (see
 * debugController.ts for exactly what "paused"/"breakpoint" mean given
 * AgentExecutor's real control surface).
 */
export interface DebugStatePayload {
  agentId: string;
  paused: boolean;
  atBreakpoint?: { phase: string; boundary: 'before' | 'after' };
  messages: unknown[];
  stepCount: number;
  breakpoints: string[];
}

/**
 * One message in the chat thread, mapped 1:1 from the SDK's real
 * `Message` (src/providers/llm.ts) rather than a separate invented shape -
 * only `id`/`timestamp` are added (the SDK's `Message` carries neither),
 * for React keys and the mockup's per-bubble timestamp. `role: 'system'`
 * messages are included for completeness (they're part of the real
 * conversation AgentExecutor sees) but the client filters them out of the
 * rendered bubble list, matching the mockup (which only ever shows
 * user/agent bubbles).
 */
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  timestamp: string;
  /** `'run'` marks the user turn a top-bar Run added (shown as "Run input"); `'steer'` a delivered steer message (shown as "Steered"). */
  source?: 'run' | 'steer';
}

/** The live chat transcript for one agent's current session, pushed over WS and returned by `GET /agents/:id/chat`. */
export interface ChatStatePayload {
  agentId: string;
  sessionId: string;
  messages: ChatMessage[];
}

/** Metadata for one past (or current) chat session, as listed by `GET /agents/:id/chats`. */
export interface ChatSessionMeta {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  /** Truncated text of the first user message, for a browsable session list. */
  preview: string;
}

/** A full past chat session, as returned by `GET /agents/:id/chats/:sessionId`. */
export interface ChatSessionRecord extends ChatSessionMeta {
  messages: ChatMessage[];
}

/**
 * The run states one canvas node can be in, pushed as `node` frames.
 * `waiting` is the approval-wait pause (the run is paused on a human
 * decision for that node's tool); the other three mirror a span's
 * start/end.
 */
export type NodeRunState = 'running' | 'done' | 'error' | 'waiting';

/**
 * One `node` frame: the run state of the builder node `nodeId` (the
 * §3.3 ids - `agent`, `tool:<name>`, `sub:<n>/...`, `guard:<id>`,
 * `handoff:<to>`), derived server-side from a span carrying the
 * `lousho.node.id` attribute (see server/nodeStates.ts). Frames carry
 * node ids and state only - never attribute values, args or secrets -
 * and each one follows the `span` frame it was derived from.
 */
export interface NodeStatePayload {
  nodeId: string;
  state: NodeRunState;
  /** The span this state was derived from - correlates with `span` frames of the same id. */
  spanId: string;
  /** ISO time the server derived the state (the notification's arrival, not the span's own timestamps). */
  at: string;
}

/**
 * One recorded tool result pinned for a "run from here" re-run (T04):
 * when the pinned run's model calls `toolName` again, the
 * `studio-pins` preToolCall hook answers with `result` instead of
 * executing the tool. `nodeId` is the canvas node id (`tool:<key>`,
 * PLAN §3.3) for display and un-pinning; `args`, when set, restricts the
 * pin to calls whose arguments stable-stringify-equal it. Pins apply to
 * that one run only - they are never stored and never sent on chat turns.
 */
export interface ToolPin {
  nodeId: string;
  /** The called tool name (`gen_ai.tool.name` on the span). */
  toolName: string;
  /** When set, only calls with canonical-equal args are pinned. */
  args?: Record<string, unknown>;
  /** Returned to the model instead of running the tool. */
  result: unknown;
}

/**
 * The `POST /agents/:id/run` request body: the input to run, an optional
 * spec override, and optional tool-result pins (T04 "run from here").
 */
export interface RunAgentRequest {
  input: string;
  spec?: unknown;
  pins?: ToolPin[];
}

/**
 * A single WS message pushed to `WS /agents/:id/stream` subscribers.
 * `type: 'status'` carries the full AgentRunStatusPayload (sent on every
 * status transition, and once immediately on connect). `type: 'event'`
 * forwards one of the run's `AgentEvent`s (run.start/text.done/tool.start/
 * tool.done/run.done/...) for lightweight visibility into an in-progress
 * run. `type: 'log'`/`'span'`/`'debug'` are the structured log stream,
 * the Trace tab's spans and the step-debugger state, all derived from the
 * same run rather than a second parallel event system. `type: 'chat'`
 * is the live chat transcript, sent on every reconciled update and
 * once immediately on connect (mirroring 'status'). `type: 'node'` is the
 * per-node run state the canvas highlights from.
 */
export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'log'; payload: LogEntry }
  | { type: 'span'; payload: SpanEvent }
  | { type: 'debug'; payload: DebugStatePayload }
  | { type: 'chat'; payload: ChatStatePayload }
  | { type: 'node'; payload: NodeStatePayload };

/**
 * One `WS /events` push - Studio-wide lifecycle notifications every open
 * tab receives, so the agents list (and later the summaries, drafts,
 * suggestions and inbox badge) refreshes on change rather than polling.
 * `agent.changed` fires whenever an agent's spec/meta/draft state is
 * written, `reason` saying which write caused it. Events carry ids and
 * names only - never secret values.
 */
export type StudioEvent =
  | { type: 'agent.changed'; agentId: string; reason: 'save' | 'version' | 'meta' | 'draft' | 'restore' | 'import' }
  | { type: 'version.summary'; agentId: string; version: number; summary: string }
  | { type: 'draft.changed'; agentId: string; draftId: string; status: ChangeDraft['status'] }
  | { type: 'suggestion.new'; agentId: string; suggestionId: string }
  | { type: 'inbox.count'; count: number };

/** Masked provider key status. Never carries a real key. */
export interface ProviderKeyStatus {
  provider: 'openai' | 'anthropic';
  hasKey: boolean;
  /** Last-4-visible masked form for display, e.g. '••••••••3f2a'. `null` when no key is stored. Never the real key. */
  masked: string | null;
  /**
   * The provider's env var (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) is set in the server's environment. Runs fall back
   * to it when no key is stored, so a provider with only `envKey` can still run. Never the value.
   */
  envKey: boolean;
}

/**
 * Masked status of one named secret in Studio's secrets store
 * (`/settings/secrets`, `server/secretsStore.ts`). Named secrets are the
 * values `{ secret: '<name>' }` spec refs resolve to (SDK
 * `resolveSecretRef`). Never carries the value itself - `masked` is the
 * last-4 display form, `hasValue`/`updatedAt` describe the record.
 */
export interface SecretStatus {
  name: string;
  hasValue: boolean;
  /** Last-4-visible masked form for display, e.g. '••••••••c123'. `null` when no value is stored. Never the real value. */
  masked: string | null;
  /** ISO time of the last write; `null` when no value is stored. */
  updatedAt: string | null;
}

/**
 * The hardcoded 5s hook-sandbox timeout, now configurable per profile
 * (see hookSandbox.ts's `HookSandboxOptions.timeoutMs`). The sandbox
 * BACKEND stays NoopSandbox-only: `src/security/sandboxCore.ts` (the only
 * SandboxAdapter this SDK ships today) exports just `NoopSandbox` - there is
 * no second real adapter (e.g. a Docker-backed one) yet to offer a picker
 * over, so `sandboxBackend` here is a single-valued field reserved for when
 * one exists rather than a dropdown with one option pretending to be a choice.
 */
export interface SettingsProfile {
  id: string;
  name: string;
  /** Matches an `AgentSpec.provider.type` value ('mock' | 'openai' | 'anthropic' | 'ollama' | 'openrouter'). */
  providerType: string;
  /** Which `secretsStore` provider's stored key to use when `providerType` is one of `SECRET_PROVIDERS` ('openai' | 'anthropic'). `undefined` for 'mock'/'ollama'/'openrouter' (env-var/no-key providers). */
  providerKeyRef?: string;
  /** Deploy target name - see `src/deploy/index.ts`'s `registerBuiltInAdapters()` for the real registered names this must match. */
  deployAdapter: string;
  /** Opt-in bundled OTel export toggle (ADDITIONALLY exports to a real collector via `src/execution/otel.ts`'s `createOtelTraceExporter()`, not a replacement for the trace panel). */
  otelEnabled: boolean;
  /** Passed through to `hookSandbox.ts`'s `sandboxRunHook()` as `timeoutMs`. */
  hookTimeoutMs: number;
  sandboxBackend: 'noop';
}

export interface SettingsFile {
  activeProfileId: string;
  profiles: SettingsProfile[];
  /** Stored partial overrides for the Agent Author's model choices; `readAuthorSettings` merges the defaults under them. */
  author?: Partial<AuthorSettings>;
  /** Stored partial overrides for the background passes' model choices and per-kind switches; `SettingsStore.passes()` merges the defaults under them. */
  passes?: PassSettings;
}

/**
 * The background passes' kinds (L06): version summaries, draft reviews,
 * portability checks, prompt suggestions, auto approvals and eval judges.
 * Declared here (not in `server/passes/passRunner.ts`) so the Settings
 * card can enumerate them - one declaration, imported by the server.
 */
export type PassKind =
  | 'version_summary'
  | 'draft_review'
  | 'portability_check'
  | 'prompt_suggestion'
  | 'auto_approval'
  | 'eval_judge';

/** Every `PassKind`, in display order. */
export const PASS_KINDS: readonly PassKind[] = [
  'version_summary',
  'draft_review',
  'portability_check',
  'prompt_suggestion',
  'auto_approval',
  'eval_judge',
];

/** The Settings card's row label per pass kind. */
export const PASS_KIND_LABELS: Record<PassKind, string> = {
  version_summary: 'Version summaries',
  draft_review: 'Draft reviews',
  portability_check: 'Portability checks',
  prompt_suggestion: 'Prompt suggestions',
  auto_approval: 'Automatic tool approvals',
  eval_judge: 'Eval judges',
};

/**
 * `GET/PUT /settings/passes`'s answer (L06b): which model the passes call,
 * which model auto-approvals use, and which kinds run at all. Stored
 * sparsely in `settings.json` under `passes`; `SettingsStore.passes()`
 * merges stored values over these defaults.
 */
export interface PassSettings {
  /** `provider/model` the pass kinds share; default `anthropic/claude-haiku-5-5`. */
  model: string;
  /** `provider/model` auto-approvals score tool calls with; default `anthropic/claude-haiku-5-5`. */
  autoApprovalModel: string;
  /** Per-kind on/off; default every kind on. */
  enabled: Record<PassKind, boolean>;
}

/** A `PUT /settings/passes` body: any subset of {@link PassSettings}, `enabled` itself sparse per kind. */
export interface PassSettingsPatch {
  model?: string;
  autoApprovalModel?: string;
  enabled?: Partial<Record<PassKind, boolean>>;
}

/** The `GET /settings/passes/spend` answer (L06a): this window's totals rolled up per kind. */
export interface PassSpendSummary {
  month: string;
  totalUsd: number;
  calls: number;
  byKind: Partial<Record<PassKind, { calls: number; costUsd: number }>>;
}

/** R2: `POST /agents/:id/deploy`'s result - the shelled-out `lousho build` child process's outcome. */
export interface DeployResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * One step of a run's checkpoint history (`GET /runs/:id/history`,
 * where a run id is the session id: the agent id, or a fork's id) - the
 * newest checkpoint saved at that step of the latest execution.
 */
export interface RunHistoryStep {
  step: number;
  status: CheckpointStatus;
  savedAt: string;
  /** The model's finish reason for this step: `tool_calls` when it called tools, else as recorded. */
  finishReason?: string;
  /** The step's tool calls; `result` is absent while a call has none. */
  toolCalls: TrajectoryStep['tools'];
  /** This step's model call, when its usage (and price) is known. */
  tokens?: number;
  costUsd?: number;
}

export interface RunHistoryPayload {
  runId: string;
  steps: RunHistoryStep[];
}

/** `POST /runs/:id/fork` body - see `ForkPatch` (src/execution/checkpoint.ts). */
export interface ForkRunRequest {
  fromStep: number;
  patch?: { toolResult?: { toolCallId: string; result: unknown }; appendInput?: string; businessState?: unknown };
}

/** The started fork; its live status streams on `WS /agents/<runId>/stream`. */
export interface ForkRunResponse {
  runId: string;
  fromStep: number;
  status: AgentRunStatusPayload;
}

/** `GET /runs/compare?a=&b=` - `compareTrajectories(a, b)`. */
export type RunComparisonPayload = TrajectoryComparison;

/**
 * `GET /workspace`'s response: `baseDir` is the workspace root the client
 * keys its draft cache by (unchanged); `workspace` is the full ref so the
 * client can address this workspace by id on later requests.
 */
export interface WorkspaceInfo {
  baseDir: string;
  workspace: WorkspaceRef;
}

/**
 * One row of `GET /workspaces`: the registry's `WorkspaceRef` plus the
 * per-request facts the route computes (`isLaunch` is a per-process fact,
 * `available`/`agentCount` come from the folder's current state - none of
 * them is stored in `workspaces.json`).
 */
export interface WorkspaceListItem extends WorkspaceRef {
  /** The folder Studio was started in this session. It cannot be removed while Studio runs. */
  isLaunch: boolean;
  /** false when `root` no longer exists or is not a directory (moved, unmounted). */
  available: boolean;
  /** `.lousho/agents/*.yaml` count; 0 when unavailable. */
  agentCount: number;
}

/**
 * `GET /workspaces`'s response: every registered workspace, sorted by name
 * (case-insensitive), then id; `defaultId` is the launch workspace's id -
 * the workspace requests with no `x-lousho-workspace`/`?ws=` resolve to.
 */
export interface WorkspaceList {
  defaultId: string;
  workspaces: WorkspaceListItem[];
}

/** `POST /workspaces`'s body: the folder path goes in the body, never in a URL (it can name a user's home directory). */
export interface AddWorkspaceRequest {
  root: string;
}

/** One `POST /playground/run` message (server/playground.ts; the Playground screen's editor rows). */
export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The `POST /playground/run` body. */
export interface PlaygroundRunRequest {
  messages: PlaygroundMessage[];
  variables?: Record<string, string>;
  /** `provider/model` (`openai/gpt-4o-mini`, `mock`, `ollama/llama3.2`). */
  model: string;
  /** Tool names the Studio already resolves (`current-date`, `day-name`, `http`, `web-fetch`, `demo-approval`). */
  tools?: string[];
  promptRef?: string;
}

/** One SSE `data:` payload of the `POST /playground/run` stream; every stream ends with one `done` or `error`. */
export type PlaygroundEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'done'; finishReason: string; text: string; traceId?: string; usage?: AgentEventUsage }
  | { type: 'error'; message: string; code?: string };

/**
 * Agent metadata Studio keeps next to the spec in
 * `.lousho/agents/<id>/meta.json` (PLAN Contract B): everything about the
 * agent that is not the spec itself - enable state, failure streak,
 * labels and publish state.
 */
export interface AgentMeta {
  schemaVersion: 1;
  enabled: boolean;
  disabledAt: string | null;
  disabledReason: 'manual' | 'auto_failure_streak' | null;
  failureStreak: number;
  labels: string[];
  createdFrom?: { kind: 'blank' | 'template' | 'import' | 'copy' | 'author'; ref?: string };
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The canvas layout Studio keeps next to the spec in
 * `.lousho/agents/<id>/layout.json` (PLAN Contract B): node positions,
 * sticky notes and the last viewport - presentation state the spec
 * deliberately does not carry.
 */
export interface CanvasLayout {
  schemaVersion: 1;
  nodes: Record<string, { x: number; y: number; collapsed?: boolean }>;
  notes: Array<{ id: string; x: number; y: number; text: string }>;
  viewport?: { x: number; y: number; zoom: number };
}

/**
 * Why a version was written (Contract B). `baseline` records the spec as
 * found on disk before Studio overwrites a file it did not write itself
 * (external edit or pre-versioning agent); `restore`/`publish` mark the
 * lifecycle transitions that produce a new version.
 */
export type VersionKind = 'create' | 'update' | 'restore' | 'baseline' | 'publish';

/** Which Studio surface caused the version - attribution for the Versions tab. */
export type VersionSource =
  | 'editor'
  | 'author'
  | 'import'
  | 'draft'
  | 'suggestion'
  | 'restore'
  | 'external_file_edit'
  | 'template'
  | 'copy';

/**
 * Everything a version restores: the spec v2 working copy plus the
 * `meta.json` labels (labels are restorable state; `enabled` deliberately
 * is not - a restore never re-enables an agent).
 */
export interface SpecSnapshot {
  spec: AgentSpecV2;
  labels: string[];
}

/**
 * One line of `.lousho/agents/<id>/versions/index.jsonl`: everything the
 * versions list renders without loading the full snapshot.
 */
export interface VersionListItem {
  version: number;
  kind: VersionKind;
  source: VersionSource;
  /** Top-level spec keys + 'labels', in canonical order - the change chips. */
  changedFields: string[];
  restoredFromVersion: number | null;
  /** Filled later by the summary pass; null until then. */
  summary: string | null;
  /** The Author message that caused this version, clamped to 400 chars. */
  requestText: string | null;
  authorSessionId: string | null;
  /** `specHash()` of the snapshot's spec - cheap no-op and external-edit detection. */
  specHash: string;
  createdAt: string;
}

/** One `.lousho/agents/<id>/versions/<NNNNNN>.json` file: a list item plus the full restorable snapshot. */
export interface VersionRecord extends VersionListItem {
  snapshot: SpecSnapshot;
}

/**
 * The most recent activity an `AgentListItem` reports on `GET /agents`: the
 * live run's status while one is not `idle`, else the newest persisted
 * trace's outcome (`done`, or `error` when the run failed).
 */
export interface AgentLastRun {
  status: RunStatus;
  /** ISO time of the status update (live run) or the trace's end (persisted run). */
  at: string;
  traceId?: string;
}

/**
 * One row of `GET /agents` (the Agents list, A02): everything the card needs
 * without loading the full record - identity fields from the spec, state from
 * `meta.json`, a `counts` summary for the chips, and `lastRun` when the agent
 * has ever run.
 */
export interface AgentListItem {
  id: string;
  name: string;
  /** `spec.description`, `''` when the spec has none. */
  description: string;
  model: string;
  enabled: boolean;
  /** Why the agent is off (`meta.disabledReason`) - the card's Auto-off pill keys on `'auto_failure_streak'` (L12). */
  disabledReason?: AgentMeta['disabledReason'];
  labels: string[];
  /** Spec file mtime - what the list sorts and displays as "last edited". */
  updatedAt: string;
  publishedVersion: number | null;
  lastRun?: AgentLastRun;
  /** Section sizes the card chips render (A03). */
  counts: { tools: number; mcpServers: number; subagents: number; triggers: number };
}

/**
 * Where an agent's publish pointer (L14a) stands: the pinned version, whether
 * the working copy still hashes to that version's spec, and when it was
 * pinned. `version: null` means nothing is published.
 */
export interface PublishState {
  version: number | null;
  /** `specHash(working copy) === published version's specHash`; `false` when `version` is null. */
  matchesWorkingCopy: boolean;
  /** `createdAt` of the pinned version record, `null` when `version` is null. */
  publishedAt: string | null;
}

/**
 * `GET /agents/:id` (v2): the working copy plus its `meta.json`/`layout.json`
 * sidecars and the newest version number - the detail header's (A05) and
 * Author's (AA06) one-read view of an agent.
 */
export interface AgentRecord {
  id: string;
  spec: AgentSpecV2;
  meta: AgentMeta;
  layout: CanvasLayout;
  updatedAt: string;
  /** Newest version number, `null` when the agent has no versions yet. */
  latestVersion: number | null;
  /** The publish pointer's state (L14a) - whether the working copy still matches what is published. */
  publishState: PublishState;
  /**
   * The spec's readiness rows (`computeRequirements`, AA13): what the agent
   * needs before it can run. The header's readiness chips and the Author's
   * proposal cards read this; it is advisory only and never blocks a save.
   */
  requirements?: Requirement[];
}

/**
 * `POST /agents`'s `from`: a blank spec, a shipped SDK template's id
 * (`GET /templates` lists them), or a copy of another agent's id.
 */
export type CreateAgentFrom = 'blank' | { template: string } | { copyOf: string };

/**
 * A requirement kind a template's `template.json` `requires` list may name
 * (PLAN §8.5 `Requirement['kind']`): what the created agent will need
 * before it can run. This union stands in for the full `Requirement` type
 * until AA13 defines it - AA13 must import this type rather than redefine
 * it.
 */
export type RequirementKind = 'provider_key' | 'secret' | 'mcp' | 'tool' | 'model';

/**
 * One readiness row `computeRequirements` returns (AA13, PLAN §8.5) - on
 * `GET /agents/:id/requirements`, on `AgentRecord.requirements` and on the
 * Author's proposal cards. `id` is exact and dedupe-stable
 * (`provider:<p>`, `model:<id>`, `secret:<NAME>`, `env:<VAR>`, `mcp:<key>`,
 * `tool:<name>`, `file:<path>`, `registry:<name>`); `status` is `ok`,
 * `missing` or `unknown`; `label` names the thing, never a secret value;
 * `fix` is the action that makes the row `ok` where one exists. Rows sort
 * `missing`, then `unknown`, then `ok`, then by `id`.
 */
export interface Requirement {
  id: string;
  kind: RequirementKind;
  status: 'ok' | 'missing' | 'unknown';
  label: string;
  fix?: { action: 'add_secret' | 'open_settings' | 'probe'; target: string };
}

/**
 * One row of `GET /templates` (the Templates screen's card grid): the
 * display fields of `templates/<id>/template.json` - everything the card
 * needs without loading the spec.
 */
export interface TemplateSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  requires: RequirementKind[];
}

/**
 * `GET /templates/:id` (the template detail sheet and the `{ template }`
 * create branch): the summary plus the parsed spec v2 and the README text
 * ('' when the template ships no `README.md`).
 */
export interface TemplateDetail {
  summary: TemplateSummary;
  spec: AgentSpecV2;
  readme: string;
}

/**
 * `POST /agents` body: what to create, plus an optional display name
 * (`spec.name`; blank defaults to 'Untitled agent', copy to '<name> copy').
 */
export interface CreateAgentRequest {
  from: CreateAgentFrom;
  name?: string;
}

/**
 * `PATCH /agents/:id/meta` body: the enable toggle and/or the label set -
 * at least one key is required (an empty patch is `LOUSHO_BODY_INVALID`).
 * Meta changes never write a version.
 */
export interface PatchAgentMetaRequest {
  enabled?: boolean;
  labels?: string[];
}

/**
 * One row of an instructions line diff: 'add'/'del' changed lines,
 * 'context' lines kept around a change, 'gap' a run of unchanged lines
 * collapsed to a count. What `SpecChange.lines` carries for an
 * instructions edit (server/diff/specChange.ts).
 */
export type LineDiff =
  | { kind: 'add' | 'del' | 'context'; text: string }
  | { kind: 'gap'; count: number };

/** The grouping the diff view renders a `SpecChange` under. */
export type SpecSection =
  | 'Identity'
  | 'Model'
  | 'Instructions'
  | 'Tools'
  | 'Knowledge'
  | 'Safety'
  | 'Triggers'
  | 'Flow';

/**
 * One human-readable change between two spec snapshots: a plain field's
 * add/remove/edit, or one item of a keyed list (`tools[web-fetch]`).
 * `lines` carries the line diff only for an instructions string edit.
 * Computed server-side by `diffSpecs` (server/diff/specChange.ts).
 */
export interface SpecChange {
  /** The spec field, or `field[key]` for one item of a keyed list ('model' | 'tools[web-fetch]' | 'mcpServers[github]' | 'labels' ...). */
  field: string;
  /** Display name ('Model' | 'Tool: web-fetch' ...). */
  label: string;
  /** The diff view's section this change groups under. */
  section: SpecSection;
  op: 'add' | 'remove' | 'edit';
  before?: unknown;
  after?: unknown;
  lines?: LineDiff[];
}

/**
 * Where a change draft came from: the Author ('author'), a suggestion
 * pass ('suggestion') or a hand-made API call ('manual').
 */
export type DraftOrigin = 'author' | 'suggestion' | 'manual';

/**
 * The draft lifecycle: `pending` while it sits in
 * `.lousho/agents/<id>/drafts/current.json` (at most one per agent),
 * then `approved`/`rejected`/`withdrawn` once it moves to `drafts/history/`.
 */
export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/**
 * A patch over a spec plus labels (the same semantics the Author's
 * AuthorPatch uses): an omitted key keeps the current value, `null`
 * removes the key (`labels: null` clears to `[]`), any other value
 * replaces - lists wholesale. `version` is never patchable.
 */
export type SpecPatch = { [K in Exclude<keyof AgentSpecV2, 'version'>]?: AgentSpecV2[K] | null } & {
  labels?: string[] | null;
};

/** One thing the draft auto-review flagged, grouped by rubric area. */
export interface DraftConcern {
  area: 'safety' | 'coherence' | 'trigger_reach';
  detail: string;
}

/**
 * The advisory auto-review a pending draft carries once the review pass
 * has looked at it (filled by the pass, never at create time). The
 * `fingerprint` binds the verdict to the exact submission it judged;
 * `safe` is null whenever no model verdict exists (`unavailable`).
 */
export interface DraftAutoReview {
  outcome: 'clear' | 'escalated' | 'unavailable';
  safe: boolean | null;
  rationale: string;
  concerns: DraftConcern[];
  fingerprint: string;
  model: string | null;
  checkedAt: string;
}

/**
 * The draft's changed field paths split by risk class (L11a): `routine`
 * edits can be reviewed at a glance, `gated` ones always need the user's
 * click. Paths are `SpecChange.field` values ('tools[web-fetch]').
 */
export interface DraftFieldClasses {
  routine: string[];
  gated: string[];
}

/**
 * One `.lousho/agents/<id>/drafts/` record: a proposed patch to the
 * working copy, pending review. `baseVersion`/`baseSpecHash` snapshot
 * what the draft was written against so the UI can flag drift
 * (currentVersion > baseVersion). `note` is the reviewer's comment on
 * approve/reject; `autoReview` stays null until the review pass runs.
 */
export interface ChangeDraft {
  id: string;
  agentId: string;
  status: DraftStatus;
  origin: DraftOrigin;
  patch: SpecPatch;
  reason: string;
  /** Latest version number when the draft was made (drift = current > base); null when there are none yet. */
  baseVersion: number | null;
  /** `specHash()` of the working copy when the draft was made. */
  baseSpecHash: string;
  autoReview: DraftAutoReview | null;
  /** Routine/gated split of the draft's changed fields; null until the review pass classifies them. */
  classes: DraftFieldClasses | null;
  /** Reviewer note recorded on approve/reject. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

/**
 * `GET /agents/:id/draft`'s answer (L11b): the pending draft plus the
 * diff of its patch over the working copy, computed per request so the
 * Suggestions tab always shows today's spec, not the draft's base.
 * `currentVersion` is the latest version number (0 when there are none)
 * - the drift banner shows when it is greater than `baseVersion`.
 */
export interface DraftView extends ChangeDraft {
  changes: SpecChange[];
  currentVersion: number;
}

/** `POST /agents/:id/draft`'s body: the patch plus where it came from and why. */
export interface CreateDraftRequest {
  patch: SpecPatch;
  origin: DraftOrigin;
  reason: string;
}

/** `POST /agents/:id/draft/approve` · `/reject`'s body - both fields optional. */
export interface SettleDraftRequest {
  /** Guards a stale sheet: when given and not the current draft's id, the route answers 409. */
  draftId?: string;
  /** Reviewer note recorded on the settled draft. */
  note?: string;
}

/**
 * The prompt-suggestion lifecycle: `open` while it waits in
 * `.lousho/agents/<id>/suggestions/`, `applied` once its edit landed on
 * the instructions, `dismissed` when the user rejected it, `conflict`
 * when the instructions moved past its `expectedPromptHash`.
 */
export type SuggestionStatus = 'open' | 'applied' | 'dismissed' | 'conflict';

/**
 * The five friction classes a prompt suggestion may name (R05): the
 * single smallest instructions change the pass judged worth a person's
 * review, picked for the best ratio of waste removed to risk.
 */
export type OptimizationClass =
  | 'Missing operational fact'
  | 'Missing tool strategy'
  | 'Ambiguous instruction'
  | 'Misplaced guidance'
  | 'Over-broad instruction';

/**
 * One `.lousho/agents/<id>/suggestions/<id>.json` record the prompt
 * optimizer pass writes: an anchored `oldText` → `newText` edit of the
 * instructions. `oldText` occurs exactly once in the instructions and the
 * edit is at most 15 changed lines. `expectedPromptHash` is the CAS key -
 * apply only rewrites when the current instructions still hash to it and
 * the rewrite hashes to `proposedPromptHash`.
 */
export interface PromptSuggestion {
  kind: 'prompt_edit';
  id: string;
  agentId: string;
  /** Trace the optimizer pass read to find this friction. */
  sourceTraceId: string;
  /** `promptHash(instructions)` when the suggestion was generated. */
  expectedPromptHash: string;
  /** `promptHash(instructions after the edit)` - verified on apply. */
  proposedPromptHash: string;
  oldText: string;
  newText: string;
  confidence: 'high' | 'low';
  optimizationClass: OptimizationClass;
  evidence: string;
  expectedSaving: string;
  risk: string;
  validationPlan: string[];
  status: SuggestionStatus;
  createdAt: string;
  updatedAt: string;
  /** When the suggestion left `open` (`applied`/`dismissed`/`conflict`); `null` while open. */
  resolvedAt: string | null;
  /** The version a landed apply wrote; `null` until `applied`. */
  appliedVersion: number | null;
}

/** Where in the spec a portability finding sits (L09a). */
export type PortabilityLocation = 'instructions' | 'triggers' | 'tools' | 'mcpServers' | 'hooks' | 'other';

/** What kind of owner-specific reference a portability finding is (L09a). */
export type PortabilityKind =
  | 'repository'
  | 'email_address'
  | 'channel'
  | 'path'
  | 'host'
  | 'secret'
  | 'person'
  | 'url'
  | 'other';

/**
 * One flagged sender-specific reference the portability check pass
 * reported: the exact `quote`, where it sits in the spec, what it is,
 * and the placeholder/edit the recipient should make.
 */
export interface PortabilityFinding {
  location: PortabilityLocation;
  kind: PortabilityKind;
  quote: string;
  explanation: string;
  suggestion: string;
}

/**
 * One `.lousho/agents/<id>/suggestions/<id>.json` record the portability
 * check pass writes on export/copy/import: the findings plus
 * `adaptedInstructions` (the instructions rewritten with `[YOUR …]`
 * placeholders, `null` when nothing needed adapting). Cached by
 * `specHash` - re-run only when the spec changed. `agentId` is `null`
 * for pasted import text (cached in memory instead of the store).
 */
export interface PortabilityAnalysis {
  kind: 'portability';
  id: string;
  agentId: string | null;
  /** `specHash()` of the spec this analysis ran on - the cache key. */
  specHash: string;
  summary: string;
  findings: PortabilityFinding[];
  adaptedInstructions: string | null;
  /** The `provider/model` the pass ran on; `null` when no model was reached. */
  model: string | null;
  createdAt: string;
}

/** What a `suggestions/<id>.json` file holds - discriminated on `kind`. */
export type StoredSuggestion = PromptSuggestion | PortabilityAnalysis;

/**
 * `GET /catalog/*` rows - the SDK catalogs, so picker picklists always show
 * what this SDK actually supports. The row shapes are derived from the SDK
 * functions themselves (`ReturnType`) rather than re-declared, so they can
 * never drift from what the SDK reports; `import type` keeps the SDK out of
 * the browser bundle.
 */

/** `GET /catalog/models` row: the SDK's `listModels` entry - `available` is additionally true server-side when Studio holds a stored key for the provider. */
export type CatalogModel = ReturnType<typeof listModels>[number];

/** `GET /catalog/tools` row: one `{ builtin }` tool from `listBuiltinTools`. */
export type CatalogTool = ReturnType<typeof listBuiltinTools>[number];

/** `GET /catalog/guardrails` row: one starter-set guardrail from `listGuardrails`. */
export type CatalogGuardrail = ReturnType<typeof listGuardrails>[number];

/** `GET /catalog/triggers` row: one trigger type from `listTriggerTypes`. */
export type CatalogTriggerType = ReturnType<typeof listTriggerTypes>[number];

/** `GET /catalog/skills` row: a registry-index item of `type: 'skill'`, referenced by a spec's `{ registry: name }` ref. */
export interface CatalogSkill {
  name: string;
  description: string;
  ref: { registry: string };
}

/** `GET /catalog/kits` row: a registry-index item of `type: 'kit'` (a whole agent directory). */
export interface CatalogKit {
  name: string;
  description: string;
}

/**
 * One `mcpServers` entry as a v2 spec writes it - the v1 entry shape with
 * `SecretRef` (`{ env }`/`{ secret }`) allowed where secrets go. Derived
 * from `AgentSpecV2` so it can never drift from the spec type.
 */
export type McpServerSpecV2 = NonNullable<AgentSpecV2['mcpServers']>[string];

/** The webhook trigger variant - `SecretRef` is extracted from its `secret` field below. */
type WebhookTriggerSpec = Extract<NonNullable<AgentSpecV2['triggers']>[number], { type: 'webhook' }>;

/**
 * A spec v2 secret reference: `{ env: 'NAME' }` reads the process env,
 * `{ secret: 'name' }` reads Studio's secrets store - never a literal
 * value. Extracted from the webhook trigger's `secret` field so it can
 * never drift (the SDK keeps the `SecretRef` type itself private -
 * server/routes/mcpProbe.ts mirrors it by hand as `ProbeSecretRef`).
 */
export type SecretRef = NonNullable<WebhookTriggerSpec['secret']>;

/** `POST /catalog/mcp/probe`'s body: the one server to connect and list. */
export interface McpProbeRequest {
  server: McpServerSpecV2;
}

/** One tool a probe found, `name` without the route's `probe__` namespace. */
export interface McpProbeTool {
  name: string;
  description: string;
}

/**
 * `POST /catalog/mcp/probe`'s answer: the tools the server advertised, or
 * why it could not be reached (connection failures are `ok: false` in a
 * 200, never HTTP errors).
 */
export type McpProbeResponse = { ok: true; tools: McpProbeTool[] } | { ok: false; error: string };

/**
 * `GET /agents/:id/export?format=bundle`'s body (L07): the working-copy
 * spec plus the pieces that live outside the YAML - labels, the prompt
 * registry text `spec.promptRef` points at, and the eval datasets the
 * spec gates on. Secret values never appear: the spec only ever holds
 * `{ env }`/`{ secret }` references.
 */
export interface AgentBundle {
  kind: 'lousho.agent-bundle';
  version: 1;
  spec: AgentSpecV2;
  labels: string[];
  prompts: Array<{ name: string; version: number; content: string }>;
  evals?: Array<{ dataset: string; examples: Array<{ input: unknown; expected: unknown | null }> }>;
  /** ISO time the bundle was built. */
  exportedAt: string;
}

/**
 * How `POST /agents/import` resolves the pasted spec's id (L08a): `new`
 * takes the first free `<slug>`/`<slug>-N`, `copy` writes `<base>-copy[-N]`
 * beside `targetId` (or the suggested id), `replace` overwrites `targetId`.
 */
export type ImportMode = 'new' | 'replace' | 'copy';

/** `POST /agents/import/preview` and `POST /agents/import` body. */
export interface ImportRequest {
  /** Pasted YAML, JSON spec, or `lousho.agent-bundle` text (at most 1 MB). */
  text: string;
  mode: ImportMode;
  /** The agent `replace` overwrites, or the id `copy` derives its name from. */
  targetId?: string;
}

/**
 * `POST /agents/import/preview`'s answer (L08a): the parsed spec after
 * `upgradeSpec`, what each mode would write it as, and everything the
 * import sheet shows before committing - the name clash, the readiness
 * rows, the bundle's prompts and the warnings (bad tags dropped, spec
 * upgraded, daemon-bound prompts).
 */
export interface ImportPreview {
  format: 'yaml' | 'json' | 'bundle';
  /** The spec after `upgradeSpec` - what would be written. */
  spec: AgentSpecV2;
  /** Bundle labels, normalised; `[]` for a bare spec. */
  labels: string[];
  /** `slugifyAgentId(spec.name)` - the id `new` starts from. */
  suggestedId: string;
  /** The existing agent `suggestedId` names, or `null` when it is free. */
  clash: { id: string; name: string } | null;
  /** The id the requested `mode` would write. */
  resolvedId: string;
  /** The spec's readiness rows (`computeRequirements`, AA13). */
  requirements: Requirement[];
  /** The bundle's prompts (`{ name, version }` - content stays server-side). */
  prompts: Array<{ name: string; version: number }>;
  warnings: string[];
}

/**
 * The inbox alert kinds (L12 producers; R04a adds `low_rating` writes).
 * Declared here - not in server/inbox/alertStore.ts - because the inbox
 * wire items below carry it and wireTypes must stay isomorphic.
 */
export type AlertKind = 'auto_disabled' | 'publish_failed' | 'low_rating';

/** What waits on the user in the Inbox (R02a): a tool approval, an `ask_question`, a pending draft, an open prompt suggestion or an alert. */
export type InboxItemKind = 'approval' | 'question' | 'draft' | 'suggestion' | 'alert';

export interface InboxItemBase {
  /** Stable id: `<kind>:<agentId>:<ref>` - approval/question `<approvalId>`, draft `<draftId>`, suggestion `<suggestionId>`, alert `<alertId>`. */
  id: string;
  kind: InboxItemKind;
  agentId: string;
  /** The workspace the item belongs to (`WorkspaceRef.id`); `?ws=all` merges items across workspaces (W09a). */
  workspaceId: string;
  agentName: string;
  title: string;
  detail: string | null;
  /** ISO instant it started waiting. */
  at: string;
}

/**
 * One row of `GET /inbox` (PLAN §10): everything across this workspace's
 * agents that needs a human. Sorted by `expiresAt` ascending (soonest
 * deadline first, items without one last), then `at` descending.
 */
export type InboxItem =
  | (InboxItemBase & { kind: 'approval'; approvalId: string; toolName: string; args: Record<string, unknown>; expiresAt: string | null })
  | (InboxItemBase & { kind: 'question'; approvalId: string; question: string; options: string[]; allowFreeText: boolean; expiresAt: string | null })
  | (InboxItemBase & { kind: 'draft'; draftId: string; origin: DraftOrigin; gated: boolean })
  | (InboxItemBase & { kind: 'suggestion'; suggestionId: string; confidence: 'high' | 'low' })
  | (InboxItemBase & { kind: 'alert'; alertId: string; alertKind: AlertKind; payload: Record<string, unknown> });

/** `GET /inbox/count`'s answer - also the `inbox.count` WS event's payload. */
export interface InboxCount {
  count: number;
}

/** `POST /agents/:id/rating`'s body (R04a): a 1-5 human score on the run's trace. */
export interface RatingRequest {
  traceId: string;
  value: 1 | 2 | 3 | 4 | 5;
  /** Optional rationale, at most 2000 chars; the low-rating alert keeps its first 280. */
  comment?: string;
}

/** Human-score labels, indexed by `value - 1`. */
export const RATING_LABELS = ['Poor', 'Fair', 'Good', 'Great', 'Excellent'] as const;

/** Ratings at or below this value raise a `low_rating` inbox alert (R04a). */
export const LOW_RATING_MAX = 2;
