/**
 * `piAgent()` (Harness 3, "pi-coder"): the Pi coding agent
 * (`@earendil-works/pi-coding-agent`, an optional peer) as a Lousho
 * sub-agent, in process, behind the `task` tool.
 *
 * Each delegated task is one Pi session: the `task` call's `sessionId`
 * becomes the Pi session id, so a resumed task (or a paused one being
 * decided, even in a fresh process) reopens the same session file and the
 * next prompt continues where the previous turn stopped.
 *
 * Approval gating: a `tool_call` extension handler applies `permissions`
 * (the same `PermissionRule`s `createAgent()` takes) to every Pi tool call.
 * A `deny` rule refuses the call; an `ask` rule blocks it with
 * `{ block: true, terminate: true }`, which ends the Pi turn, and `run()`
 * throws `SubagentApprovalPause` - the lead run pauses on it durably. On
 * `resolve`, the adapter reopens the Pi session, marks that exact
 * tool-name+args call as allowed once, and tells Pi the call was approved
 * (Pi has no "run the blocked call" API; the model re-issues it and the
 * gate lets that one call through). A rejection sends the decision's note
 * as the next user turn.
 *
 * Node-only: Pi runs local tools (`read`, `bash`, `edit`, `write`) against
 * `cwd`. Usage rides `RemoteRunOptions.onUsage` into the lead's totals.
 */

import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { SDKError } from '../execution/errors';
import { SubagentApprovalPause } from '../execution/subagentRuntime';
import { checkPermission, type PermissionRule } from '../execution/permissions';
import type { PendingApproval } from '../execution/ApprovalGate';
import type { AgentEventUsage } from '../execution/agentEvents';
import { loadOptionalPeer } from '../providers/optionalPeer';
import { newId } from '../utils/id';
import { defineRemoteSubagent } from './remoteAgent';
import type { RemoteSubagent } from './types';

/**
 * The parts of `@earendil-works/pi-coding-agent` the adapter uses, declared
 * structurally so the SDK's public types do not reference the optional peer
 * (a consumer without it still typechecks - `piAgent()` fails at run()).
 */
interface PiCodingAgent {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager;
    findById(cwd: string, id: string, sessionDir?: string): string | undefined;
  };
  SettingsManager: { create(cwd: string, agentDir?: string): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => PiResourceLoader;
}

interface PiResourceLoader {
  reload(): Promise<void>;
}

interface PiSessionManager {
  getSessionId(): string;
}

interface PiUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface PiSessionStats {
  tokens: PiUsageTotals;
  cost: number;
  assistantMessages: number;
}

/** pi-ai `Usage` (the totals a turn's assistant/toolResult messages carry). */
interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

interface PiTextBlock {
  type: string;
  text?: string;
}

interface PiToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}

interface PiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly state: { messages: PiMessage[] };
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  /**
   * Appends a `custom` message (LLM sees it as a user turn) and, with
   * `triggerTurn`, runs a turn on it. Decisions go in as custom messages so
   * the task prompt stays the last `user` message - the boundary the run
   * usage of a continued pause is measured from.
   */
  sendCustomMessage(
    message: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> },
    options?: { triggerTurn?: boolean }
  ): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  getSessionStats(): PiSessionStats;
  dispose(): void;
}

/** A Pi `tool_call` extension event (the subset the gate reads). */
interface PiToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

type PiToolCallResult = { block?: boolean; reason?: string; terminate?: boolean };
type PiExtensionApi = { on(event: 'tool_call', handler: (event: PiToolCallEvent) => Promise<PiToolCallResult | undefined>): unknown };
type PiExtensionFactory = (pi: PiExtensionApi) => void;

/** Options of {@link piAgent}. */
export interface PiAgentOptions {
  /** The directory the Pi sub-agent works in; its file tools resolve relative paths against it. */
  cwd: string;
  /**
   * The model Pi runs on: a pi-ai `Model` (e.g. `modelRuntime.getModel('openrouter', 'openai/gpt-4o-mini')`,
   * or `fauxProvider().getModel()` in tests). When omitted, Pi's own model resolution applies
   * (a session-restored model, then the settings default).
   */
  model?: unknown;
  /** What the sub-agent does, shown to the lead model so it can pick it. Required. */
  description: string;
  /** Name used in errors and the result footer; defaults to the key in `subagents`. */
  name?: string;
  /**
   * Permission rules applied to every Pi tool call, in order (same shape as
   * `createAgent({ permissions })`): `deny` refuses the call, `ask` pauses
   * the lead run for approval when the caller can pause (the lead set an
   * approval store) and refuses it otherwise, `allow`/no match lets it run.
   * `rule.when` receives the Pi call's arguments.
   */
  permissions?: readonly PermissionRule[];
  /**
   * The pi-coding-agent `ModelRuntime` to use; defaults to one reading
   * `<agentDir>/auth.json` and `models.json` plus environment API keys.
   */
  modelRuntime?: unknown;
  /** Pi config directory; defaults to Pi's own (`~/.pi/agent`). */
  agentDir?: string;
  /**
   * Where Pi keeps its session files; defaults to Pi's per-cwd session dir
   * under `agentDir`. Task resume and approval resume reopen sessions by id
   * from this directory, so every `piAgent` that should continue a task must
   * resolve to the same one.
   */
  sessionDir?: string;
  /** Pi tool allowlist (e.g. `['read', 'bash', 'edit', 'write']`); defaults to Pi's built-in coding tools. */
  tools?: readonly string[];
  /** Pi thinking level (`'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`); defaults to Pi's. */
  thinkingLevel?: string;
}

const PI_PEER = '@earendil-works/pi-coding-agent';

async function loadPi(): Promise<PiCodingAgent> {
  return loadOptionalPeer(PI_PEER, () => import('@earendil-works/pi-coding-agent').then((m) => m as unknown as PiCodingAgent));
}

/** Pi's per-cwd session dir under `agentDir` (mirrors pi-coding-agent's `getDefaultSessionDir`). */
function defaultSessionDir(cwd: string, agentDir: string): string {
  const resolved = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const safe = `--${resolved.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`;
  return `${agentDir.replace(/[\\/]+$/, '')}/sessions/${safe}`;
}

/** A Pi `tool_call` gate: permission rules plus the once-allowed calls of an approved resume. */
function makeGate(permissions: readonly PermissionRule[] | undefined, pausable: boolean, sessionId: string) {
  const state: { pending?: PendingApproval; onceAllowed: { toolName: string; args: Record<string, unknown> }[] } = { onceAllowed: [] };
  const factory: PiExtensionFactory = (pi) => {
    pi.on('tool_call', async (event: PiToolCallEvent): Promise<PiToolCallResult | undefined> => {
      const approved = state.onceAllowed.findIndex((once) => once.toolName === event.toolName && isDeepStrictEqual(once.args, event.input));
      if (approved >= 0) {
        state.onceAllowed.splice(approved, 1);
        return undefined;
      }
      const entry = await checkPermission(
        { permissions },
        { toolName: event.toolName, toolCallId: event.toolCallId, sessionId, args: event.input }
      );
      const action = entry?.decision ?? 'default';
      if (action === 'deny') {
        return { block: true, reason: entry?.rule?.reason ?? 'Denied by the sub-agent permission rules.' };
      }
      if (action === 'ask') {
        if (!pausable) {
          return { block: true, reason: 'This call needs human approval and cannot run unattended.' };
        }
        // The first gated call is the pending approval; any later gated call of the
        // same run is blocked too, so a mixed batch cannot partially escape the gate.
        state.pending ??= {
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: structuredClone(event.input),
          createdAt: new Date().toISOString(),
        };
        return { block: true, terminate: true, reason: 'Blocked: waiting for the user to approve this call.' };
      }
      return undefined;
    });
  };
  return { factory, state };
}

/** The tool call whose `id` is `approvalId`, from the reopened session's transcript. */
function findCall(session: PiSession, approvalId: string): PiToolCall | undefined {
  for (const message of session.state.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const call = (message.content as PiToolCall[]).find((c) => c.type === 'toolCall' && c.id === approvalId);
    if (call) return call;
  }
  return undefined;
}

/** Last assistant message, if any. */
function lastAssistant(session: PiSession): PiMessage | undefined {
  return [...session.state.messages].reverse().find((m) => m.role === 'assistant');
}

/** The assistant message's text parts joined; empty string when it had none. */
function textOf(message: PiMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  return (message.content as PiTextBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  assistantMessages: number;
}

function totalsOf(stats: PiSessionStats): UsageTotals {
  return { ...stats.tokens, cost: stats.cost, assistantMessages: stats.assistantMessages };
}

/**
 * The usage of everything before the pausing task prompt: messages up to the
 * last `user` message of the transcript. Decision turns go in as `custom`
 * messages, so through a chain of pauses the original task prompt stays that
 * boundary and a continuation reports exactly what the remote run spent.
 */
function usageBeforeLastUser(session: PiSession): UsageTotals {
  const messages = session.state.messages;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      cut = i;
      break;
    }
  }
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, assistantMessages: 0 };
  for (let i = 0; i < cut; i++) {
    const message = messages[i];
    if (message.role === 'assistant') totals.assistantMessages++;
    const usage = message.usage;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.total += usage.totalTokens;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals;
}

/**
 * Pi usage as the {@link AgentEventUsage} the lead rolls up (M10b). `base`
 * diffs against the stats the remote run started from: a call's own spend
 * normally, the whole paused run's spend on a continuation (the harness
 * subtracts what the pausing call already reported, `snapshot.usage`).
 */
function toEventUsage(stats: UsageTotals, base?: UsageTotals): AgentEventUsage {
  const delta = (now: number, was: number | undefined) => Math.max(0, now - (was ?? 0));
  const inputTokens = delta(stats.input, base?.input) + delta(stats.cacheRead, base?.cacheRead) + delta(stats.cacheWrite, base?.cacheWrite);
  const outputTokens = delta(stats.output, base?.output);
  return {
    promptTokens: inputTokens,
    inputTokens,
    completionTokens: outputTokens,
    outputTokens,
    totalTokens: delta(stats.total, base?.total),
    costUsd: Math.max(0, stats.cost - (base?.cost ?? 0)),
    estimated: false,
    modelCalls: Math.max(1, delta(stats.assistantMessages, base?.assistantMessages)),
  };
}

/** The `The user decided about the blocked call` turn sent to Pi on resume. */
function decisionPrompt(approved: boolean, call: PiToolCall | undefined, approvalId: string, note?: string): string {
  const what = call ? `'${call.name}' with arguments ${JSON.stringify(call.arguments)}` : `id '${approvalId}'`;
  if (approved) {
    return `The user approved the blocked tool call ${what}. Re-issue exactly that tool call now and continue the task.`;
  }
  return (
    `The user rejected the blocked tool call ${what}${note ? ` with this note: ${note}` : ''}. ` +
    'Do not run that call; accomplish the task another way, or explain that you cannot.'
  );
}

/** A paused Pi run as a sub-agent pause: the snapshot holds the gated call; `sessionId` reopens the Pi session. */
function pause(name: string, sessionId: string, pending: PendingApproval): SubagentApprovalPause {
  return new SubagentApprovalPause(name, {
    agent: { name },
    currentMessages: [],
    pendingToolCall: pending,
    steps: 0,
    sessionId,
  });
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Uses a Pi coding-agent session as a sub-agent (Harness 3). Put the result
 * in `createAgent({ subagents })` next to local and `remoteAgent()` ones:
 *
 * @example
 * ```ts
 * import { piAgent } from '@lousho/build-ai-agent';
 *
 * const lead = createAgent({
 *   model: 'openai/gpt-4o-mini',
 *   subagents: {
 *     coder: piAgent({
 *       cwd: projectDir,
 *       model: runtime.getModel('openrouter', 'openai/gpt-4o-mini'),
 *       description: 'Edits code and runs tests in the workspace',
 *       permissions: [ask(['edit', 'write']), allow('*')],
 *     }),
 *   },
 * });
 * ```
 */
export function piAgent(options: PiAgentOptions): RemoteSubagent {
  if (!options.cwd) {
    throw new SDKError("piAgent: 'cwd' is required - the directory the Pi session's tools work in.", 'LOUSHO_CONFIG_INVALID');
  }
  if (!options.description?.trim()) {
    throw new SDKError("piAgent: 'description' is required - the lead model picks the sub-agent by it.", 'LOUSHO_CONFIG_INVALID');
  }
  const agent: RemoteSubagent = {
    name: options.name,
    description: options.description,
    async run(prompt, run = {}) {
      const pi = await loadPi();
      const name = run.name ?? options.name ?? 'pi';
      const label = `Pi sub-agent '${name}'`;
      const cwd = options.cwd;
      const agentDir = options.agentDir ?? `${homedir()}/.pi/agent`;
      const sessionDir = options.sessionDir ?? defaultSessionDir(cwd, agentDir);
      const id = run.sessionId ?? newId('task');

      // Reopen the Pi session that ran this task before (its id is the task's
      // sessionId), or start a new one under that id.
      const existing = pi.SessionManager.findById(cwd, id, sessionDir);
      let sessionManager: PiSessionManager;
      try {
        sessionManager = existing
          ? pi.SessionManager.open(existing, sessionDir, cwd)
          : pi.SessionManager.create(cwd, sessionDir, { id });
      } catch (error) {
        throw new SDKError(`${label}: could not open Pi session '${id}': ${(error as Error).message}`, 'LOUSHO_REMOTE_REQUEST_FAILED');
      }
      if (run.decision && !existing) {
        throw new SDKError(
          `${label}: cannot decide approval '${run.decision.approvalId}': no Pi session '${id}' found in '${sessionDir}'.`,
          'LOUSHO_REMOTE_REQUEST_FAILED'
        );
      }

      const gate = makeGate(options.permissions, run.pausable === true, id);
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [gate.factory],
        // Hermetic: the sub-agent runs the coding tools and this gate, not the user's Pi setup.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();

      let session: PiSession;
      try {
        ({ session } = await pi.createAgentSession({
          cwd,
          agentDir,
          model: options.model,
          modelRuntime: options.modelRuntime,
          sessionManager,
          settingsManager,
          resourceLoader,
          ...(options.tools && { tools: [...options.tools] }),
          ...(options.thinkingLevel && { thinkingLevel: options.thinkingLevel }),
        }));
      } catch (error) {
        throw new SDKError(`${label}: could not start the Pi session: ${(error as Error).message}`, 'LOUSHO_REMOTE_REQUEST_FAILED');
      }

      const signal = run.signal;
      const onAbort = () => void session.abort();
      try {
        if (signal) {
          if (signal.aborted) throw abortError();
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Usage base: a decision continuation reports the whole paused run's
        // spend (the lead subtracts the pausing call's report); any other call
        // reports what it spent since this call opened the session.
        const base = run.decision ? usageBeforeLastUser(session) : totalsOf(session.getSessionStats());
        try {
          if (run.decision) {
            const call = findCall(session, run.decision.approvalId);
            if (run.decision.approved && call) gate.state.onceAllowed.push({ toolName: call.name, args: call.arguments });
            await session.sendCustomMessage(
              {
                customType: 'lousho-approval-decision',
                content: decisionPrompt(run.decision.approved, call, run.decision.approvalId, run.decision.note),
                display: false,
                details: { approved: run.decision.approved, approvalId: run.decision.approvalId, note: run.decision.note },
              },
              { triggerTurn: true }
            );
          } else {
            await session.prompt(prompt, { expandPromptTemplates: false });
          }
        } catch (error) {
          if (signal?.aborted || (error as Error)?.name === 'AbortError') throw abortError();
          throw error instanceof SDKError
            ? error
            : new SDKError(`${label} failed: ${(error as Error)?.message ?? String(error)}`, 'LOUSHO_REMOTE_REQUEST_FAILED');
        }

        const report = () => run.onUsage?.(toEventUsage(totalsOf(session.getSessionStats()), base));
        if (signal?.aborted) throw abortError();
        // The run stopped right at the gated call's refused result only when its
        // whole tool batch terminated; if Pi continued past it, the refusal stands
        // and the run's own outcome is returned (a gated call batched with ungated
        // ones cannot suspend the lead mid-batch - Pi decides that per batch).
        const pending = gate.state.pending;
        const last = session.state.messages.at(-1);
        if (pending && last?.role === 'toolResult' && last.toolCallId === pending.toolCallId) {
          report();
          throw pause(name, session.sessionId, pending);
        }
        const lastMessage = lastAssistant(session);
        if (lastMessage?.stopReason === 'error') {
          throw new SDKError(`${label} failed: ${lastMessage.errorMessage ?? 'the model run ended in an error'}`, 'LOUSHO_REMOTE_REQUEST_FAILED');
        }
        if (lastMessage?.stopReason === 'aborted') throw abortError();
        report();
        const footer = `[pi sub-agent '${name}': session '${session.sessionId}', taskId '${run.taskId ?? 'none'}']`;
        const text = textOf(lastMessage);
        return text ? `${text}\n\n${footer}` : footer;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        session.dispose();
      }
    },
  };
  return defineRemoteSubagent(agent);
}
