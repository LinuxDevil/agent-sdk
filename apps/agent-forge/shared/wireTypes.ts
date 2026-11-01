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
 * A tool call an in-progress run is paused on, awaiting a human decision
 * via `POST /agents/:id/approve`. Mirrors the subset of
 * `PendingApproval` (src/execution/ApprovalGate.ts) the UI needs to render
 * an inline approve/reject card, without leaking the full ExecutionSnapshot.
 */
export interface PendingApprovalInfo {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

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
  updatedAt: string;
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
  /** `'run'` marks the user turn a top-bar Run added (shown as "Run input", not as a typed message). */
  source?: 'run';
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
 * A single WS message pushed to `WS /agents/:id/stream` subscribers.
 * `type: 'status'` carries the full AgentRunStatusPayload (sent on every
 * status transition, and once immediately on connect). `type: 'event'`
 * forwards one of the run's `AgentEvent`s (run.start/text.done/tool.start/
 * tool.done/run.done/...) for lightweight visibility into an in-progress
 * run. `type: 'log'`/`'span'`/`'debug'` are the structured log stream,
 * the Trace tab's spans and the step-debugger state, all derived from the
 * same run rather than a second parallel event system. `type: 'chat'`
 * is the live chat transcript, sent on every reconciled update and
 * once immediately on connect (mirroring 'status').
 */
export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'log'; payload: LogEntry }
  | { type: 'span'; payload: SpanEvent }
  | { type: 'debug'; payload: DebugStatePayload }
  | { type: 'chat'; payload: ChatStatePayload };

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

/**
 * The advisory auto-review a pending draft carries once the review pass
 * has looked at it (filled by the pass, never at create time). The
 * `fingerprint` binds the verdict to the exact submission it judged.
 */
export interface DraftAutoReview {
  outcome: 'approved' | 'escalated' | 'unavailable';
  safe: boolean;
  rationale: string;
  concerns: { area: 'safety' | 'coherence' | 'trigger_reach'; detail: string }[];
  modelId: string | null;
  checkedAt: string;
  fingerprint: string;
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
  /** Reviewer note recorded on approve/reject. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
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
