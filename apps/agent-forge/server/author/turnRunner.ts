/**
 * The Author turn runner: `start(sessionId, { requestId, text })` runs one
 * Author turn with the SDK's `createAgent` over the persisted transcript,
 * emits typed server events with a per-turn `seq`, enforces one running
 * turn per session (in-memory slot), and persists the user message at the
 * start and the assistant message at the end - before `turn.finished`, so
 * a client that renders the finished event already sees a saved chat.
 *
 * The agent gets `maxSteps: AUTHOR_MAX_STEPS`, and a per-tool invalid-input
 * cap (`AUTHOR_INVALID_INPUT_CAP`): a model that keeps sending arguments
 * the schema rejects burns the turn instead of looping forever.
 *
 * Provider resolution never falls back to mock (PLAN 16.4): a missing key
 * is a `NO_PROVIDER_KEY` start failure. Tests use the `providerFor` seam.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  createAgent,
  type AgentEvent,
  type LLMProvider,
  type ToolDescriptor,
} from 'lousho';
import type {
  AuthorFocus,
  AuthorMessage,
  AuthorSession,
  AuthorUserMessage,
} from '../../shared/authorWire';
import type { SettingsStore } from '../settingsStore';
import type { SecretsStore } from '../secretsStore';
import { AuthorSessionNotFoundError, type AuthorSessionStore } from './sessionStore';
import { buildTurnContext, type TurnContextInput } from './turnContext';
import { toModelMessages } from './modelMessages';
import { readAuthorSettings } from './settings';
import { resolveAuthorProvider } from './provider';
import { TranscriptBuilder } from './transcriptBuilder';

/** A chat send's `requestId`: client-generated, 8-64 chars of the session-id charset. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Longest user text a turn accepts. */
const AUTHOR_MAX_TEXT_CHARS = 20_000;

/** The step cap a turn's `createAgent` runs under (PLAN 8.1). */
// fallow-ignore-next-line unused-export -- part of the turn-runner contract AA06+ tools and tests read
export const AUTHOR_MAX_STEPS = 12;

/** Per-tool count of invalid-argument calls at which the turn is cut short (`'tool_input_cap'`). */
// fallow-ignore-next-line unused-export -- part of the turn-runner contract AA06+ tools and tests read
export const AUTHOR_INVALID_INPUT_CAP = 3;

/**
 * Everything one running turn hands to the tools `buildTools` closes over:
 * identity and focus, the transcript as it was BEFORE this turn's user
 * message, that message itself, the abort signal, the remaining step
 * budget, and a scratch map for cross-tool state (save gate, review
 * rounds).
 */
export interface AuthorTurn {
  sessionId: string;
  requestId: string;
  focus: AuthorFocus;
  storedTranscript: readonly AuthorMessage[];
  userMessage: AuthorUserMessage;
  signal: AbortSignal;
  stepsRemaining(): number;
  state: Map<string, unknown>;
}

/** The runner's collaborators; everything but the stores is a seam the wiring or a test fills. */
export interface AuthorTurnRunnerDeps {
  sessions: AuthorSessionStore;
  settings: SettingsStore;
  secrets: SecretsStore;
  /** The byte-stable system prompt (AA05's AUTHOR_SYSTEM_PROMPT). */
  systemPrompt: () => string;
  /** The turn's tools, built per turn so they close over `AuthorTurn` (AA06's buildAuthorTools). */
  buildTools: (turn: AuthorTurn) => ToolDescriptor[];
  /** The per-turn context block's inputs (focus, focused-agent summary, open cards). */
  turnContextInput: (session: AuthorSession, now: Date) => Promise<TurnContextInput>;
  /** Test seam: resolves the provider without the stored/env key lookup. */
  providerFor?: (model: string) => LLMProvider;
  /** Test seam: the turn clock (`turnContextInput` and message timestamps). */
  now?: () => Date;
}

/** `start`/`continueAfterUiEvent`'s outcome: the accepted `requestId`, or why no turn began. */
export type AuthorStartResult =
  | { ok: true; requestId: string }
  | { ok: false; code: 'BUSY' | 'NO_PROVIDER_KEY' | 'NOT_FOUND' | 'INVALID_INPUT'; message: string };

function fail(code: 'BUSY' | 'NO_PROVIDER_KEY' | 'NOT_FOUND' | 'INVALID_INPUT', message: string): AuthorStartResult {
  return { ok: false, code, message };
}

/** The live per-session slot: who owns it, how to stop it, and how it ended early. */
interface TurnSlot {
  requestId: string;
  controller: AbortController;
  /** `stop()` asked for this turn: its finish reason reports `'stopped'`. */
  stopped: boolean;
  /** The invalid-input cap tripped: reports `'tool_input_cap'`. */
  inputCapHit: boolean;
}

/** Everything `prepare` gathers that `beginTurn` and `runTurn` need. */
interface PreparedTurn {
  provider: LLMProvider;
  modelId: string;
  focus: AuthorFocus;
  storedTranscript: readonly AuthorMessage[];
  userMessage: AuthorUserMessage;
}

/** Mutable per-turn state the event handlers share (the `AuthorTurn` itself is the read view). */
interface RunContext {
  slot: TurnSlot;
  seq: number;
  stepsDone: number;
  /** `run.done`'s finishReason, once it arrives. */
  finishReason?: string;
  builder: TranscriptBuilder;
  /** `tool.start` args by call id, for `tool.pending`'s `input`. */
  toolInputs: Map<string, unknown>;
  /** Invalid-argument failures per tool name, for `AUTHOR_INVALID_INPUT_CAP`. */
  invalidInputs: Map<string, number>;
  turn: AuthorTurn;
}

/**
 * Runs Author turns. Emits `'event'` with `(sessionId, AuthorServerEvent)`
 * in emission order; the `seq` inside each event counts up per turn so a
 * resumed client can dedupe.
 */
export class AuthorTurnRunner extends EventEmitter {
  private readonly deps: AuthorTurnRunnerDeps;
  private readonly slots = new Map<string, TurnSlot>();

  constructor(deps: AuthorTurnRunnerDeps) {
    super();
    this.deps = deps;
  }

  /** The running turn's requestId for `sessionId`, when one is in flight. */
  // fallow-ignore-next-line unused-class-member -- called through Pick<AuthorTurnRunner, 'running'> in author/routes.ts (DELETE 409)
  running(sessionId: string): { requestId: string } | undefined {
    const slot = this.slots.get(sessionId);
    return slot === undefined ? undefined : { requestId: slot.requestId };
  }

  /** Aborts the turn `requestId` owns in `sessionId`; `false` when it isn't running. */
  stop(sessionId: string, requestId: string): boolean {
    const slot = this.slots.get(sessionId);
    if (slot === undefined || slot.requestId !== requestId) return false;
    slot.stopped = true;
    slot.controller.abort();
    return true;
  }

  /**
   * Validates the send, reserves the session's one turn slot synchronously
   * (two racing sends can't both pass `running()`), persists the user
   * message with its turn-context block, emits `turn.started`, and runs
   * the model loop unawaited.
   */
  async start(
    sessionId: string,
    req: { requestId: string; text: string; focus?: AuthorFocus }
  ): Promise<AuthorStartResult> {
    const invalid = this.validateStart(req);
    if (invalid !== undefined) return invalid;
    if (this.slots.has(sessionId)) {
      return fail('BUSY', 'A reply is already running in this chat. Wait for it to finish, then send again.');
    }
    const slot = this.reserve(sessionId, req.requestId);
    const prepared = await this.prepare(sessionId, req.focus, { kind: 'send', text: req.text });
    if (!prepared.ok) {
      this.release(sessionId, slot);
      return prepared.result;
    }
    return this.beginTurn(sessionId, slot, prepared.prepared);
  }

  /**
   * Runs a turn with no new user text: the caller already appended the
   * `uiEvent` user message (a card Apply, a saved secret) the model should
   * react to. That stored message becomes the turn's `userMessage`.
   */
  async continueAfterUiEvent(sessionId: string): Promise<AuthorStartResult> {
    if (this.slots.has(sessionId)) {
      return fail('BUSY', 'A reply is already running in this chat. Wait for it to finish, then send again.');
    }
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    const slot = this.reserve(sessionId, requestId);
    const prepared = await this.prepare(sessionId, undefined, { kind: 'continuation' });
    if (!prepared.ok) {
      this.release(sessionId, slot);
      return prepared.result;
    }
    return this.beginTurn(sessionId, slot, prepared.prepared);
  }

  /** The send-body checks: text trimmed to 1..AUTHOR_MAX_TEXT_CHARS, requestId in charset. */
  private validateStart(req: { requestId?: unknown; text?: unknown }): AuthorStartResult | undefined {
    if (typeof req.text !== 'string' || req.text.trim().length === 0) {
      return fail('INVALID_INPUT', 'Type a message first.');
    }
    if (req.text.trim().length > AUTHOR_MAX_TEXT_CHARS) {
      return fail('INVALID_INPUT', `That message is too long (max ${AUTHOR_MAX_TEXT_CHARS.toLocaleString('en-US')} characters).`);
    }
    if (typeof req.requestId !== 'string' || !REQUEST_ID_RE.test(req.requestId)) {
      return fail('INVALID_INPUT', 'Bad request id.');
    }
    return undefined;
  }

  /** Takes the session's slot before the first `await`; released on every early return and in `finishTurn`. */
  private reserve(sessionId: string, requestId: string): TurnSlot {
    const slot: TurnSlot = { requestId, controller: new AbortController(), stopped: false, inputCapHit: false };
    this.slots.set(sessionId, slot);
    return slot;
  }

  private release(sessionId: string, slot: TurnSlot): void {
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
  }

  /**
   * Everything a turn needs before the model loop starts: the session
   * (NOT_FOUND), a real provider (NO_PROVIDER_KEY - never mock), and the
   * send's user message appended to the transcript with the turn's
   * context block (or, for a continuation, the already-stored uiEvent
   * message split off the tail of the transcript).
   */
  private async prepare(
    sessionId: string,
    focusOverride: AuthorFocus | undefined,
    mode: { kind: 'send'; text: string } | { kind: 'continuation' }
  ): Promise<{ ok: true; prepared: PreparedTurn } | { ok: false; result: AuthorStartResult }> {
    const session = await this.deps.sessions.get(sessionId);
    if (session === undefined) return { ok: false, result: fail('NOT_FOUND', 'Chat not found.') };
    const resolved = this.providerFor(readAuthorSettings(this.deps.settings).model);
    if (!resolved.ok) return { ok: false, result: fail('NO_PROVIDER_KEY', resolved.message) };
    const focus = focusOverride ?? session.focus;
    if (mode.kind === 'continuation') {
      const last = session.transcript[session.transcript.length - 1];
      if (last === undefined || last.role !== 'user') {
        return { ok: false, result: fail('INVALID_INPUT', 'No user message to continue from.') };
      }
      return {
        ok: true,
        prepared: {
          provider: resolved.provider,
          modelId: resolved.modelId,
          focus,
          storedTranscript: session.transcript.slice(0, -1),
          userMessage: last,
        },
      };
    }
    const now = this.now();
    const turnContext = buildTurnContext(await this.deps.turnContextInput({ ...session, focus }, now));
    const userMessage: AuthorUserMessage = {
      id: `m_${randomUUID()}`,
      role: 'user',
      text: mode.text,
      at: now.toISOString(),
      turnContext,
    };
    await this.deps.sessions.update(sessionId, (s) => ({
      ...s,
      focus,
      transcript: [...s.transcript, userMessage],
    }));
    return {
      ok: true,
      prepared: {
        provider: resolved.provider,
        modelId: resolved.modelId,
        focus,
        storedTranscript: session.transcript,
        userMessage,
      },
    };
  }

  /** The provider for `model`: the test seam, or the real key-backed resolution. */
  private providerFor(model: string): { ok: true; provider: LLMProvider; modelId: string } | { ok: false; message: string } {
    if (this.deps.providerFor !== undefined) {
      const slash = model.indexOf('/');
      const modelId = slash === -1 ? model : model.slice(slash + 1);
      return { ok: true, provider: this.deps.providerFor(model), modelId };
    }
    const resolved = resolveAuthorProvider(model, this.deps.secrets);
    return resolved.ok ? { ok: true, provider: resolved.provider, modelId: resolved.modelId } : resolved;
  }

  /** Emits `turn.started`, returns the send's acceptance, and runs the model loop without awaiting it. */
  private beginTurn(sessionId: string, slot: TurnSlot, prepared: PreparedTurn): AuthorStartResult {
    const ctx: RunContext = {
      slot,
      seq: 0,
      stepsDone: 0,
      builder: new TranscriptBuilder(),
      toolInputs: new Map(),
      invalidInputs: new Map(),
      turn: {
        sessionId,
        requestId: slot.requestId,
        focus: prepared.focus,
        storedTranscript: prepared.storedTranscript,
        userMessage: prepared.userMessage,
        signal: slot.controller.signal,
        stepsRemaining: () => AUTHOR_MAX_STEPS - ctx.stepsDone,
        state: new Map(),
      },
    };
    this.push(sessionId, ctx, { type: 'turn.started', requestId: slot.requestId });
    void this.runTurn(sessionId, ctx, prepared);
    return { ok: true, requestId: slot.requestId };
  }

  /** The model loop: `createAgent` + `agent.stream` events folded into parts and server events. */
  private async runTurn(sessionId: string, ctx: RunContext, prepared: PreparedTurn): Promise<void> {
    let failed: { message: string; code?: string } | undefined;
    try {
      const agent = createAgent({
        name: 'lousho-author',
        provider: prepared.provider,
        model: prepared.modelId,
        instructions: this.deps.systemPrompt(),
        tools: this.toolsFor(ctx.turn),
        maxSteps: AUTHOR_MAX_STEPS,
      });
      const input = toModelMessages([...ctx.turn.storedTranscript, ctx.turn.userMessage]);
      for await (const ev of agent.stream(input, { signal: ctx.slot.controller.signal, throwOnError: false })) {
        this.handleEvent(sessionId, ctx, ev);
      }
    } catch (error) {
      if (!ctx.slot.controller.signal.aborted) {
        failed = {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: unknown })?.code as string | undefined,
        };
      }
    }
    await this.finishTurn(sessionId, ctx, failed);
  }

  /** The turn's tools as a name-keyed record sorted by name, so the model's request prefix is stable. */
  private toolsFor(turn: AuthorTurn): Record<string, ToolDescriptor> {
    const named = this.deps.buildTools(turn).map((tool) => [toolName(tool), tool] as const);
    named.sort((a, b) => a[0].localeCompare(b[0]));
    return Object.fromEntries(named);
  }

  /** One `AgentEvent` -> transcript part + server event (the lookup table keeping `runTurn` flat). */
  private handleEvent(sessionId: string, ctx: RunContext, ev: AgentEvent): void {
    switch (ev.type) {
      case 'text.delta':
        ctx.builder.text(ev.text);
        this.push(sessionId, ctx, { type: 'text.delta', requestId: ctx.slot.requestId, text: ev.text });
        break;
      case 'tool.start':
        ctx.toolInputs.set(ev.toolCallId, ev.args);
        ctx.builder.toolStart(ev.toolCallId, ev.toolName, ev.args);
        this.push(sessionId, ctx, {
          type: 'tool.call',
          requestId: ctx.slot.requestId,
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          input: ev.args,
        });
        break;
      case 'tool.done':
        this.onToolDone(sessionId, ctx, ev);
        break;
      case 'tool.error':
        this.onToolError(sessionId, ctx, ev);
        break;
      case 'step.done':
        ctx.stepsDone += 1;
        break;
      case 'run.done':
        ctx.finishReason = ev.finishReason;
        break;
      default:
        break;
    }
  }

  private onToolDone(sessionId: string, ctx: RunContext, ev: AgentEvent & { type: 'tool.done' }): void {
    const pending = isPendingCard(ev.toolName, ev.result);
    ctx.builder.toolDone(ev.toolCallId, ev.result, pending);
    const base = { requestId: ctx.slot.requestId, toolCallId: ev.toolCallId, name: ev.toolName };
    if (pending) {
      this.push(sessionId, ctx, { type: 'tool.pending', ...base, input: ctx.toolInputs.get(ev.toolCallId) });
      return;
    }
    this.push(sessionId, ctx, { type: 'tool.result', ...base, output: ev.result, state: 'done' });
  }

  private onToolError(sessionId: string, ctx: RunContext, ev: AgentEvent & { type: 'tool.error' }): void {
    const output = { ok: false, code: ev.error.code ?? 'TOOL_ERROR', error: ev.error.message };
    ctx.builder.toolError(ev.toolCallId, output);
    this.push(sessionId, ctx, {
      type: 'tool.result',
      requestId: ctx.slot.requestId,
      toolCallId: ev.toolCallId,
      name: ev.toolName,
      output,
      state: 'error',
    });
    // An args-validation failure arrives as a tool.error whose name is the
    // SDK's ToolArgumentsValidationError (the event carries no `code`); each
    // one counts toward the per-tool invalid-input cap.
    if (ev.error.name === 'ToolArgumentsValidationError') {
      const count = (ctx.invalidInputs.get(ev.toolName) ?? 0) + 1;
      ctx.invalidInputs.set(ev.toolName, count);
      if (count >= AUTHOR_INVALID_INPUT_CAP) {
        ctx.slot.inputCapHit = true;
        ctx.slot.controller.abort();
      }
    }
  }

  /**
   * Persists the assistant message (skipped when the turn produced no
   * parts), releases the slot, THEN emits `turn.finished`/`turn.error` -
   * so the file on disk already holds the reply when the client sees the
   * event.
   */
  private async finishTurn(
    sessionId: string,
    ctx: RunContext,
    failed: { message: string; code?: string } | undefined
  ): Promise<void> {
    const finishReason = ctx.slot.stopped
      ? 'stopped'
      : ctx.slot.inputCapHit
        ? 'tool_input_cap'
        : failed !== undefined
          ? 'error'
          : (ctx.finishReason ?? 'aborted');
    const message = ctx.builder.message({
      id: `m_${randomUUID()}`,
      at: this.now().toISOString(),
      requestId: ctx.slot.requestId,
      finishReason,
    });
    if (message.parts.length > 0) {
      try {
        await this.deps.sessions.update(sessionId, (s) => ({ ...s, transcript: [...s.transcript, message] }));
      } catch (error) {
        if (!(error instanceof AuthorSessionNotFoundError)) throw error;
        // The chat file was deleted mid-turn; nothing to persist into.
      }
    }
    this.release(sessionId, ctx.slot);
    if (failed !== undefined) {
      this.push(sessionId, ctx, {
        type: 'turn.error',
        requestId: ctx.slot.requestId,
        message: `The Author stopped with an error: ${failed.message}. Your chat is saved, so you can try again.`,
        code: failed.code,
      });
      return;
    }
    this.push(sessionId, ctx, { type: 'turn.finished', requestId: ctx.slot.requestId, finishReason });
  }

  /** Emits one server event on 'event' with the next per-turn `seq`. */
  private push(sessionId: string, ctx: RunContext, event: AuthorServerEventNoSeq): void {
    this.emit('event', sessionId, { ...event, seq: ++ctx.seq });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** `AuthorServerEvent` minus `seq` (assigned by `push`). */
type AuthorServerEventNoSeq =
  | { type: 'turn.started'; requestId: string }
  | { type: 'text.delta'; requestId: string; text: string }
  | { type: 'tool.call'; requestId: string; toolCallId: string; name: string; input: unknown }
  | { type: 'tool.result'; requestId: string; toolCallId: string; name: string; output: unknown; state: 'done' | 'error' }
  | { type: 'tool.pending'; requestId: string; toolCallId: string; name: string; input: unknown }
  | { type: 'turn.finished'; requestId: string; finishReason: string }
  | { type: 'turn.error'; requestId: string; message: string; code?: string };

/** The tool-call name a `ToolDescriptor` carries (`defineTool`/loader results), else its display name. */
function toolName(tool: ToolDescriptor): string {
  return (tool as { name?: string }).name ?? tool.displayName;
}

/** Whether a `tool.done` is a client-answered card staying open: `requestSecret` reporting `status: 'pending'`. */
function isPendingCard(name: string, result: unknown): boolean {
  return name === 'requestSecret' && (result as { status?: unknown } | null)?.status === 'pending';
}
