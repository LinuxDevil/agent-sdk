/**
 * The Studio ⇄ project bridge wire protocol (PLAN §19.4, ticket W10a/W10b).
 *
 * Studio spawns `lousho bridge` inside a project folder; the process reads
 * one JSON request per line on stdin and writes one JSON response or push
 * per line on stdout (UTF-8, `\n` terminated, at most {@link MAX_LINE_BYTES}
 * per line). Everything here is type-only except the two constants, so
 * Studio can import the shapes from the package root (W14) without pulling
 * the bridge runtime into its bundle.
 */
import type { AgentSpecV2 } from '../spec/v2/types';
import type { AgentEvent } from '../execution/agentEvents';
import type { Span } from '../execution/tracing';
import type { Message } from '../providers/llm';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { PendingApproval } from '../execution/ApprovalGate';
import type { listBuiltinTools } from '../tools/catalog';
import type { listModels } from '../models/catalog';
import type { listGuardrails } from '../execution/guardrailCatalog';
import type { listTriggerTypes } from '../spec/v2/triggerCatalog';

/** Bumped only on a breaking wire change; Studio refuses a bridge whose `hello.protocol` it does not know. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** One stdin line or one stdout line may not exceed this many bytes. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Every method the protocol defines. W10a answers `hello`, `catalog`, `compile` and `shutdown`; W10b adds the run methods. */
export type BridgeMethod =
  | 'hello'
  | 'compile'
  | 'run'
  | 'chat'
  | 'steer'
  | 'abort'
  | 'resolveApproval'
  | 'answerQuestion'
  | 'catalog'
  | 'shutdown';

/** One request line: `id` correlates the response; `params` is method-shaped (see {@link BridgeParams}). */
export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  /** Client-chosen correlation id; the response echoes it (`null` when the request's id was unusable). */
  id: number;
  /** The method to run; unknown or unimplemented names answer `LOUSHO_BRIDGE_UNKNOWN_METHOD`. */
  method: M;
  /** Method-shaped parameters; absent reads as `{}`. */
  params?: BridgeParams[M];
}

/** The `error` half of a {@link BridgeResponse}: a stable `code` plus a human `message`. */
export interface BridgeErrorInfo {
  /** One sentence describing what went wrong. */
  message: string;
  /** The stable error code (`LOUSHO_BRIDGE_*`, or an `SDKError` code passed through). */
  code: string;
  /** Method-specific context (e.g. `LOUSHO_BRIDGE_PROTOCOL`'s `supported` list). */
  details?: unknown;
}

/** What the bridge writes back for a request: exactly one of `result` or `error`, with the request's `id` (`null` when unusable). */
export type BridgeResponse =
  | {
      /** The request's id, or `null` when the request itself was unusable. */
      id: number | null;
      /** The method's result payload. */
      result: unknown;
    }
  | {
      /** The request's id, or `null` when the request itself was unusable. */
      id: number | null;
      /** Why the request failed. */
      error: BridgeErrorInfo;
    };

/** The push events a run can emit on stdout while it is in flight (W10b). */
export type BridgePushEvent = 'agent' | 'span.start' | 'span.end' | 'steer.joined' | 'run.settled' | 'run.failed';

/** A server-initiated line (no `id`): `event` names the push kind, `runId` the run it belongs to, `data` its payload. */
export interface BridgePush<E extends BridgePushEvent = BridgePushEvent> {
  /** Which {@link BridgePushEvent} this is. */
  event: E;
  /** The run the event belongs to. */
  runId: string;
  /** The event's payload, shaped by `event`. */
  data: BridgePushData[E];
}

interface BridgeRunParamsBase {
  /** The agent id: `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$`, no `..`. */
  agentId: string;
  /** The AgentSpec v2 to build/run. */
  spec: AgentSpecV2;
  /** The session id (`SendOptions.sessionId` rules). */
  sessionId: string;
  /** Named secrets the spec's `{ secret }` refs need, resolved by Studio. Missing name → LOUSHO_SPEC_SECRET_MISSING. */
  secrets?: Record<string, string>;
  /** Provider keys Studio stores, e.g. `{ OPENAI_API_KEY }`. Keys must match `/^[A-Z][A-Z0-9_]*_API_KEY$/`. */
  env?: Record<string, string>;
  /** Whether run content may be captured for Studio's trace views. */
  captureContent?: boolean;
}

/** The `params` object each {@link BridgeMethod} takes; `hello`/`catalog`/`shutdown` carry little or nothing. */
export interface BridgeParams {
  /** `hello`: the protocol version the client speaks and who it is. */
  hello: {
    /** Must equal {@link BRIDGE_PROTOCOL_VERSION}; anything else answers `LOUSHO_BRIDGE_PROTOCOL`. */
    protocol: number;
    /** The client's identity, for bridge logs. */
    client: {
      /** Client name (e.g. `studio`). */
      name: string;
      /** Client version. */
      version: string;
    };
  };
  /** `compile`: spec + secrets/env, no session — answers the compile preview. */
  compile: Omit<BridgeRunParamsBase, 'sessionId' | 'captureContent'>;
  /** `run`: one user input on a fresh session (W10b). */
  run: BridgeRunParamsBase & {
    /** The user message to run. */
    input: string;
  };
  /** `chat`: prior turns plus the new user message on a session (W10b). */
  chat: BridgeRunParamsBase & {
    /** Prior turns (no 'system' role) followed by the new user message. */
    messages: Message[];
  };
  /** `steer`: inject a message into a running run (W10b). */
  steer: {
    /** The run to steer. */
    runId: string;
    /** The steer text, 1..3000 chars. */
    message: string;
  };
  /** `abort`: stop a run (W10b). */
  abort: {
    /** The run to abort. */
    runId: string;
    /** Why it was aborted, 1..200 chars; defaults to `'user'`. */
    reason?: string;
  };
  /** `resolveApproval`: decide a paused tool call (W10b). */
  resolveApproval: {
    /** The run holding the approval. */
    runId: string;
    /** The pending approval's id. */
    approvalId: string;
    /** Approve (`true`) or deny (`false`). */
    approved: boolean;
    /** Optional note attached to the decision. */
    note?: string;
  };
  /** `answerQuestion`: answer an agent's question (W10b). */
  answerQuestion: {
    /** The run holding the question. */
    runId: string;
    /** The pending question's id. */
    questionId: string;
    /** The answer text, 1..4000 chars. */
    answer: string;
  };
  /** `catalog`: no parameters. */
  catalog: Record<string, never>;
  /** `shutdown`: no parameters; the bridge stops after answering. */
  shutdown: Record<string, never>;
}

/** `hello`'s result: the SDK build Studio is talking to and the one-time catalog fingerprint. */
export interface BridgeHelloResult {
  /** The SDK's `VERSION`. */
  sdkVersion: string;
  /** AgentSpec versions this SDK reads (`[1, 2]`). */
  specVersions: number[];
  /** The protocol version the bridge speaks (`1`). */
  protocol: number;
  /** sha256 of the `catalog` payload, first 16 hex chars — lets Studio detect catalog drift. */
  catalogHash: string;
}

/** `catalog`'s result: the four pickers' option lists, straight from the SDK catalog functions. */
export interface BridgeCatalog {
  /** `listBuiltinTools()`. */
  tools: ReturnType<typeof listBuiltinTools>;
  /** `listModels()`. */
  models: ReturnType<typeof listModels>;
  /** `listGuardrails()`. */
  guardrails: ReturnType<typeof listGuardrails>;
  /** `listTriggerTypes()`. */
  triggers: ReturnType<typeof listTriggerTypes>;
}

/** `compile`'s result: the labels and names a Studio preview needs, without building an agent. */
export interface BridgeCompileResult {
  /** The spec's `model` string, for display. */
  modelLabel: string;
  /** Per `spec.tools[i]`, the model-facing tool names that ref produced. */
  toolNamesByRef: string[][];
  /** Names of the spec's `mcpServers` (servers are resolved, never connected). */
  mcpServers: string[];
}

/** `run`/`chat`'s immediate result: the run id pushes and later methods refer to. */
export interface BridgeRunStarted {
  /** The id `steer`/`abort`/approval methods and pushes use for this run. */
  runId: string;
  /** The spec's `model` string, for display. */
  modelLabel: string;
}

/** A settled run's result, pushed as `run.settled` data (W10b). */
export type BridgeRunResult = Pick<
  ExecutionResult,
  'finishReason' | 'text' | 'messages' | 'usage' | 'steps' | 'approvalId' | 'approvalIds' | 'abortReason'
> & {
  /** The structured output when the spec asked for one and it validated. */
  object?: unknown;
  /** The approval a paused run waits on, when `finishReason` is `'awaiting-approval'`. */
  pendingApproval?: PendingApproval;
};

/** The `result` each implemented method answers with; W10b fills the run methods. */
export interface BridgeResults {
  /** `hello`'s {@link BridgeHelloResult}. */
  hello: BridgeHelloResult;
  /** `compile`'s {@link BridgeCompileResult}. */
  compile: BridgeCompileResult;
  /** `run`'s {@link BridgeRunStarted}. */
  run: BridgeRunStarted;
  /** `chat`'s {@link BridgeRunStarted}. */
  chat: BridgeRunStarted;
  /** `steer`'s outcome: the steer id and whether it applied now, queued, or not at all. */
  steer: {
    /** The steer message's id. */
    id: string;
    /** `'immediate'` ran now, `'queued'` waits for the next step, `false` was not accepted. */
    applied: 'immediate' | 'queued' | false;
  };
  /** `abort`'s outcome: whether the run is aborting, was paused and dropped, or unknown. */
  abort: {
    /** `'aborting'` is winding down, `'discarded'` was paused and dropped, `'idle'` names no run. */
    state: 'aborting' | 'discarded' | 'idle';
  };
  /** `resolveApproval` always succeeds or throws. */
  resolveApproval: {
    /** Always `true` — failures are error responses, not results. */
    ok: true;
  };
  /** `answerQuestion` always succeeds or throws. */
  answerQuestion: {
    /** Always `true` — failures are error responses, not results. */
    ok: true;
  };
  /** `catalog`'s {@link BridgeCatalog}. */
  catalog: BridgeCatalog;
  /** `shutdown` acknowledges before the bridge stops. */
  shutdown: {
    /** Always `true`. */
    ok: true;
  };
}

/** The `data` payload each {@link BridgePushEvent} carries. */
export interface BridgePushData {
  /** `agent`: one {@link AgentEvent} of the run. */
  agent: AgentEvent;
  /** `span.start`: the span that began. */
  'span.start': Span;
  /** `span.end`: the span that finished. */
  'span.end': Span;
  /** `steer.joined`: whether a steer was delivered into the run. */
  'steer.joined': {
    /** The steer message's id. */
    steerId: string;
    /** `true` when the steer joined the run, `false` when it could not. */
    joined: boolean;
  };
  /** `run.settled`: the run's final {@link BridgeRunResult}. */
  'run.settled': BridgeRunResult;
  /** `run.failed`: why the run failed. */
  'run.failed': BridgeErrorInfo;
}
