/**
 * N6: handoffs inside one run. A handoff tool call is not executed as a tool:
 * it passes the same gate a tool call gets (argument validation, pre-tool
 * hooks, permission rules - `deny` settles it as a tool error, `ask` pauses
 * the run for approval - and tool guardrails), and once the other calls of
 * its step are done, a cleared call switches the run to the target in the
 * same `execute()` with the target agent's configuration (its agent,
 * provider, tools, skills, sub-agents, reasoning, guardrails, permission
 * rules and own handoffs) on the transcript the handoff's `inputFilter`
 * returns, under the target's own system prompt. Everything else (hooks,
 * limits, `maxSteps`, signal, stores, listeners, `output`, permission mode,
 * principal) stays the run's.
 *
 * The transcript records each handoff as `metadata.handoff = { from, to }`
 * on the handoff call's result and on the routing note - a marked message
 * carrying the call's validated arguments, which the target reads folded
 * into its system prompt (or an `inputFilter` drops/replaces it; when the
 * filter keeps neither, the marker lands on the last message kept). The
 * note rides the target's prompt rather than sitting mid-transcript as a
 * `system` message because the Qwen/Llama/Mistral chat templates of
 * llama.cpp, LM Studio, vLLM and Ollama reject a system message that is
 * not the first one. The marker is written in the same step as the
 * switch, so "the last marker names the active agent" holds for every
 * checkpoint and approval snapshot.
 */

import type { Message, ToolCall, ToolDefinition } from '../providers';
import type { StandardSchemaV1 } from '../utils/zodCompat';
import type { ExecuteOptions } from './AgentExecutor';
import type { SubagentSpec } from './delegation';
import type { AgentRunState } from './agentRunState';
import type { AgentConfig, ToolDescriptor } from '../types';
import { ConfigurationError, SDKError } from './errors';
import { runEventsOf } from './agentRun';
import { buildTools } from './generateStep';
import { toolErrorResult } from './toolErrors';
import { ToolRegistry } from '../tools/ToolRegistry';
import { legacyAiTool } from '../tools/toolContract';
import { NoopSandbox } from '../security/sandboxCore';
import { prepareToolCall, settleToolCall, toolHookContext, type ToolCallContext, type ToolCallOutcome } from './toolCallExecution';
import { toolOutcomeMessage, toolResultContent } from './toolResult';
import { insertToolResult } from './transcript';
import type { ToolCallScope } from './subagentRuntime';

/** What a handoff's `inputFilter` and `onHandoff` get. */
export interface HandoffInputData {
  /** The transcript so far, without the system prompt, ending with the handoff call and its result. */
  messages: Message[];
  /** The agent handing off. */
  from: string;
  /** The agent taking over. */
  to: string;
  /** The handoff tool's arguments (see `HandoffOptions.input`). */
  args: Record<string, unknown>;
}

/** The target of a handoff as a run uses it: its run configuration and its own handoffs. */
export interface HandoffTarget extends SubagentSpec {
  /** The target's own handoffs (it may hand on, or back). */
  handoffs?: readonly ResolvedHandoff[];
}

/**
 * One handoff a run offers (`ExecuteOptions.handoffs`). `createAgent({ handoffs })`
 * builds these; pass them yourself only when you call `AgentExecutor` directly.
 */
export interface ResolvedHandoff {
  /** The target agent's name: `handoff.to` and `result.agentName` after the handoff. */
  name: string;
  /** The tool the model calls to hand off. */
  toolName: string;
  /** The tool's description. */
  description: string;
  /** The tool's arguments; a call whose arguments do not match gets a tool error and hands off nothing. */
  input: StandardSchemaV1;
  /** The target's run configuration, resolved at the handoff; `input` is the text of the last user message. */
  spec: (input: string) => Promise<HandoffTarget>;
  /** What the target sees; default: everything. */
  inputFilter?: (data: HandoffInputData) => Message[] | Promise<Message[]>;
  /** Called once the handoff is decided, before the target's first model call. */
  onHandoff?: (data: HandoffInputData & { sessionId?: string }) => void | Promise<void>;
}

/** The `metadata.handoff` marker a handoff leaves in the transcript. */
export interface HandoffMarker {
  from: string;
  to: string;
}

/** A handoff call of a step that passed its checks, waiting for the switch. */
export interface HonoredHandoff {
  handoff: ResolvedHandoff;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  /** When the call's gate started (epoch ms): `onToolResult`'s latency for the honored call. */
  gatedAt: number;
}

/** Default `maxHandoffs` of a run. */
const DEFAULT_MAX_HANDOFFS = 5;

/** The agent the last `metadata.handoff` marker of `messages` hands to, if there is one. */
export function activeAgentOf(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const to = (messages[i].metadata?.handoff as Partial<HandoffMarker> | undefined)?.to;
    if (typeof to === 'string') return to;
  }
  return undefined;
}

/** The run's handoff offered under the tool name `toolName`. */
export function handoffNamed(options: Pick<ExecuteOptions, 'handoffs'>, toolName: string): ResolvedHandoff | undefined {
  return options.handoffs?.find((handoff) => handoff.toolName === toolName);
}

/**
 * The tool definitions of a run: the agent's tools, then one per handoff.
 * Throws `LOUSHO_CONFIG_INVALID` when a handoff tool's name is taken.
 */
export function runTools(options: Pick<ExecuteOptions, 'agent' | 'toolRegistry' | 'handoffs'>): ToolDefinition[] {
  const tools = buildTools(options.agent, options.toolRegistry);
  const taken = new Set(tools.map((tool) => tool.function.name));
  for (const handoff of options.handoffs ?? []) {
    if (taken.has(handoff.toolName)) {
      throw new ConfigurationError(
        `Agent '${options.agent.name}': the handoff to '${handoff.name}' uses the tool name '${handoff.toolName}', which a tool already has. ` +
          `Rename one, e.g. handoff(target, { toolName: 'transfer_to_${handoff.name}_agent' }).`,
        'handoffs'
      );
    }
    taken.add(handoff.toolName);
    tools.push({ type: 'function', function: { name: handoff.toolName, description: handoff.description, parameters: handoff.input as unknown as Record<string, unknown> } });
  }
  return tools;
}

/** Splits a step's tool calls into the ones that run as tools and the handoff calls. */
export function splitHandoffCalls(options: Pick<ExecuteOptions, 'handoffs'>, toolCalls: ToolCall[]): { calls: ToolCall[]; handoffCalls: ToolCall[] } {
  if (!options.handoffs?.length) return { calls: toolCalls, handoffCalls: [] };
  const handoffCalls = toolCalls.filter((call) => handoffNamed(options, call.function.name));
  return { calls: toolCalls.filter((call) => !handoffCalls.includes(call)), handoffCalls };
}

/** A failed handoff call's `tool` message. */
function errorMessage(toolCall: ToolCall, result: Record<string, unknown>): Message {
  const toolName = toolCall.function.name;
  return { role: 'tool', content: JSON.stringify(result), name: toolName, toolCallId: toolCall.id, toolName, isError: true };
}

/** Gives handoff calls that will not run a cancelled result (`reason` says why), in call order. */
export function cancelHandoffCalls(state: AgentRunState, handoffCalls: readonly ToolCall[], reason: string): void {
  for (const toolCall of handoffCalls) {
    const error = `Tool call was cancelled before it ran because ${reason}`;
    insertToolResult(state.messages, errorMessage(toolCall, toolErrorResult({ toolName: toolCall.function.name, error, kind: 'not-run' })));
  }
}

/** What gating a step's handoff calls decided: the call to hand off on, or the one to pause on, or neither (all settled with results). */
export interface HandoffGate {
  honored?: HonoredHandoff;
  /** The first call whose gate asked for approval; the run pauses on it exactly as on a tool's `ask`. */
  approval?: { toolCall: ToolCall; outcome: ToolCallOutcome };
}

/** Defensive: a `transfer_to_*` call is settled by the switch, never executed. */
function neverExecuted(): never {
  throw new SDKError('a handoff tool is never executed: the run switches to its target instead', 'LOUSHO_CONFIG_INVALID');
}

/** A handoff as a `ToolDescriptor`: validates arguments for the gate; its `execute` is never called. */
function handoffDescriptor(handoff: ResolvedHandoff): ToolDescriptor {
  return {
    displayName: handoff.toolName,
    inputSchema: handoff.input,
    tool: legacyAiTool(handoff.description, handoff.input, neverExecuted),
    execute: neverExecuted,
  };
}

/** The run's handoff tools as a registry - what a handoff call's gate validates against. */
export function handoffToolRegistry(options: Pick<ExecuteOptions, 'handoffs'>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const handoff of options.handoffs ?? []) registry.register(handoff.toolName, handoffDescriptor(handoff));
  return registry;
}

/**
 * The context a handoff call's gate runs with: the run's own (its hooks,
 * permission rules, mode, guardrails, callbacks), with the handoff tools as
 * the registry - `transfer_to_*` is not in the run's tool registry.
 */
function handoffCallContext(options: ExecuteOptions, messages: Message[], toolCall: ToolCall): ToolCallContext {
  const scope: ToolCallScope = {
    runtime: options,
    toolCallId: toolCall.id,
    // A handoff call starts no sub-agent; nothing it gates reaches this.
    execute: () => Promise.reject(new SDKError('a handoff call starts no sub-agent', 'LOUSHO_CONFIG_INVALID')),
  };
  return {
    agent: options.agent,
    toolRegistry: handoffToolRegistry(options),
    onToolCall: options.onToolCall,
    onToolResult: options.onToolResult,
    sandbox: options.sandbox ?? NoopSandbox,
    hooks: options.hooks,
    sessionId: options.sessionId,
    principal: options.principal,
    metadata: options.metadata,
    messages,
    signal: options.signal,
    scope,
  };
}

/** The `tool` message carrying a settled handoff call's outcome (like pushToolResult() for a batch call). */

/**
 * The `maxHandoffs` budget, checked after the call's gate cleared: a call
 * the rules would pause or deny never reaches the switch. Over budget, the
 * model gets a `kind: 'not-run'` tool error instead of a handoff.
 */
function overBudget(options: Pick<ExecuteOptions, 'maxHandoffs'>, state: AgentRunState, toolCall: ToolCall): ToolCallOutcome | undefined {
  const max = options.maxHandoffs ?? DEFAULT_MAX_HANDOFFS;
  if ((state.handoffs ?? 0) < max) return undefined;
  const toolName = toolCall.function.name;
  const error = `No handoff: this run already handed off ${max} time${max === 1 ? '' : 's'} (maxHandoffs). Answer the user yourself.`;
  return { toolCallId: toolCall.id, toolName, result: toolErrorResult({ toolName, error, kind: 'not-run' }), error };
}

/**
 * Settles a step's handoff calls once its other calls are done. The first
 * call passes the gate every tool call gets - argument validation, pre-tool
 * hooks, permission rules, tool guardrails - so a `deny` rule gives it a
 * `kind: 'denied'` tool error, an `ask` rule pauses the run for approval
 * ({@link HandoffGate.approval}), and a cleared call is honored. Every later
 * call of the same turn gets a not-run error, as before; each call gets its
 * `tool.start` here, and the honored one's `tool.done` comes with the switch.
 */
export async function takeHandoffCalls(options: ExecuteOptions, state: AgentRunState, handoffCalls: readonly ToolCall[]): Promise<HandoffGate> {
  const sink = runEventsOf(options);
  const gate: HandoffGate = {};
  for (const [index, toolCall] of handoffCalls.entries()) {
    sink?.toolStart(toolCall);
    const toolName = toolCall.function.name;
    if (index !== 0) {
      const error = toolErrorResult({ toolName, error: 'No handoff: only one handoff per turn is honored, and an earlier call of this turn handed off.', kind: 'not-run' });
      insertToolResult(state.messages, errorMessage(toolCall, error));
      sink?.toolSettled({ toolCallId: toolCall.id, toolName, result: error, error: String(error.message) });
      continue;
    }
    const handoff = handoffNamed(options, toolCall.function.name) as ResolvedHandoff;
    const ctx = handoffCallContext(options, state.messages, toolCall);
    const gatedAt = Date.now();
    let prepared = await prepareToolCall(toolCall, ctx);
    if (!prepared.rejection && !prepared.requiresApproval) {
      const over = overBudget(options, state, toolCall);
      if (over) prepared = { ...prepared, rejection: over, requiresApproval: false };
    }
    if (!prepared.rejection && !prepared.requiresApproval) {
      gate.honored = { handoff, toolCall, args: prepared.args, gatedAt };
      continue;
    }
    const outcome = await settleToolCall(prepared, ctx);
    if (outcome.requiresApproval) {
      // Like a tool call paused mid-batch: no result yet; the pause machinery owns it.
      gate.approval = { toolCall, outcome };
      continue;
    }
    insertToolResult(state.messages, toolOutcomeMessage(toolCall, outcome));
    sink?.toolSettled({ toolCallId: toolCall.id, toolName, result: outcome.result, error: outcome.error });
  }
  return gate;
}

/**
 * The honored call's settle, run once its handoff completed (the executor
 * switched `state.messages` to the target's view): the post-tool hooks see
 * its routing result and may replace what the target reads (LOU-X3), then
 * `tool.done` and `onToolResult` report it like any settled call. A
 * replacement patches the result message when the transcript kept it.
 */
export async function settleHonoredHandoff(options: ExecuteOptions, messages: Message[], honored: HonoredHandoff, marker: HandoffMarker): Promise<void> {
  const { toolCall } = honored;
  const toolName = toolCall.function.name;
  let shown: unknown = { transferred_to: marker.to };
  let replacedByHook: string | undefined;
  if (options.hooks) {
    const payload = { result: shown };
    const hook = await options.hooks.runPostToolCall(toolHookContext(toolCall, handoffCallContext(options, messages, toolCall), honored.args), payload);
    if (hook !== undefined) {
      replacedByHook = hook;
      shown = payload.result;
      const written = messages.find((message) => message.role === 'tool' && message.toolCallId === toolCall.id);
      if (written) {
        written.content = toolResultContent(shown);
        written.metadata = { ...written.metadata, replacedByHook: hook };
      }
    }
  }
  const outcome: ToolCallOutcome = { toolCallId: toolCall.id, toolName, result: shown, args: honored.args, ...(replacedByHook !== undefined && { replacedByHook }) };
  runEventsOf(options)?.toolSettled({ toolCallId: toolCall.id, toolName, result: shown, ...(replacedByHook !== undefined && { replacedByHook }) });
  await options.onToolResult?.(toolCall, outcome, Date.now() - honored.gatedAt, undefined);
}

/** The text of the last user message of `messages` (`''` when there is none). */
function lastUserText(messages: readonly Message[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** `messages` without what `once()` approvals remember (`metadata.approval`): a target never inherits the source's approvals. */
function forgetApprovals(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.metadata?.approval === undefined) return message;
    const { approval: _approval, ...metadata } = message.metadata;
    return { ...message, metadata };
  });
}

/**
 * The routing note appended to the transcript for the target: the handoff's
 * validated arguments, rendered as `key=value` (keys sorted, so the note is
 * deterministic). Marked with the handoff marker so `handoffFilters` (and
 * `activeAgentOf`) recognise it - `removeToolCalls` keeps it; a custom
 * `inputFilter` may still drop or replace it. It is built as a `system`
 * message because that is what filters expect, but {@link handOff} folds
 * every kept note into the target's own system prompt: a system message
 * that is not the conversation's first breaks the Qwen/Llama/Mistral chat
 * templates local-model servers (llama.cpp, LM Studio, vLLM, Ollama) use.
 */
function routingNote(marker: HandoffMarker, args: Record<string, unknown>): Message {
  const rendered = Object.keys(args)
    .sort()
    .map((key) => `${key}=${JSON.stringify(args[key])}`)
    .join(', ');
  const content = `[routing note - not from the user] handoff ${marker.from} -> ${marker.to}${rendered === '' ? '' : `: ${rendered}`}`;
  return { role: 'system', content, metadata: { handoff: marker } };
}

/** `messages` with the handoff's marker kept: on its result when the filter kept it, else on the last message. */
function withMarker(messages: Message[], toolCallId: string, marker: HandoffMarker): Message[] {
  const kept = messages.some((message) => message.toolCallId === toolCallId && activeAgentOf([message]) === marker.to);
  if (kept) return messages;
  const last = messages.at(-1);
  if (!last) {
    throw new ConfigurationError(`The inputFilter of the handoff from '${marker.from}' to '${marker.to}' returned no messages; keep at least one (e.g. handoffFilters.lastUserMessage).`, 'inputFilter');
  }
  return [...messages.slice(0, -1), { ...last, metadata: { ...last.metadata, handoff: marker } }];
}

/**
 * The run's own per-run tools (`transient`: a memory slot's
 * `remember_*`/`recall_*`, bound to the run's scope keys). Everything else in
 * the registry belongs to the agent that handed off, which a target must not
 * inherit.
 */
function runBoundTools(toolRegistry: ToolRegistry | undefined): [string, ToolDescriptor][] {
  return Object.entries(toolRegistry?.getAll() ?? {}).filter(([, descriptor]) => descriptor.transient === true);
}

/**
 * `registry` plus `tools`, on a fresh registry: registering onto the target's
 * own registry would leak this run's bindings into the shared spec.
 */
function registryWith(registry: ToolRegistry | undefined, tools: readonly [string, ToolDescriptor][]): ToolRegistry {
  const merged = new ToolRegistry();
  if (registry) merged.registerMany(registry.getAll());
  merged.registerMany(Object.fromEntries(tools));
  return merged;
}

/** `agent` also offering the tool `names` it does not list yet. */
function offeringTools(agent: AgentConfig, names: readonly string[]): AgentConfig {
  const missing = names.filter((name) => agent.tools?.[name] === undefined);
  if (missing.length === 0) return agent;
  return { ...agent, tools: { ...agent.tools, ...Object.fromEntries(missing.map((name) => [name, { tool: name }])) } };
}

/** The run's options with the target's configuration in place of the agent's that handed off. */
function targetOptions(options: ExecuteOptions, target: HandoffTarget): ExecuteOptions {
  // N6: the run's per-run tools (memory slots bound to the run's scope keys)
  // follow the handoff like the run's hooks and stores do; a tool the target
  // has itself wins.
  const carried = runBoundTools(options.toolRegistry).filter(([name]) => target.toolRegistry?.has(name) !== true);
  return {
    ...options,
    agent: carried.length === 0 ? target.agent : offeringTools(target.agent, carried.map(([name]) => name)),
    provider: target.provider,
    toolRegistry: carried.length === 0 ? target.toolRegistry : registryWith(target.toolRegistry, carried),
    hostedTools: target.hostedTools,
    skills: target.skills,
    subagents: target.subagents,
    reasoning: target.reasoning,
    guardrails: target.guardrails,
    permissions: target.permissions,
    handoffs: target.handoffs,
    // N2: the target's own tuning; what the lead loaded stays with the lead (see toolSearch.ts).
    toolSearch: target.toolSearch,
  };
}

/**
 * Hands the run to the target of `honored`: resolves the target, builds the
 * transcript it sees (its system prompt, then `inputFilter`'s messages with
 * the marker), calls `onHandoff`, and resolves to the run's options for the
 * target (`extend` applies its skills and sub-agents). The caller emits the
 * events and checkpoints once its state is switched.
 */
export async function handOff(
  options: ExecuteOptions,
  state: Pick<AgentRunState, 'messages' | 'agentName'>,
  { handoff, toolCall, args }: HonoredHandoff,
  extend: (options: ExecuteOptions) => Promise<ExecuteOptions>
): Promise<{ options: ExecuteOptions; messages: Message[]; marker: HandoffMarker }> {
  const marker: HandoffMarker = { from: state.agentName ?? options.agent.name, to: handoff.name };
  const toolName = toolCall.function.name;
  const result: Message = { role: 'tool', content: JSON.stringify({ transferred_to: handoff.name }), name: toolName, toolCallId: toolCall.id, toolName, metadata: { handoff: marker } };
  const transcript = state.messages[0]?.role === 'system' ? state.messages.slice(1) : [...state.messages];
  insertToolResult(transcript, result);
  // N6 follow-up: the target reads the call's validated arguments as a routing note, unless a filter drops it.
  transcript.push(routingNote(marker, args));
  const target = await handoff.spec(lastUserText(transcript));
  const data: HandoffInputData = { messages: transcript, ...marker, args };
  const filtered = handoff.inputFilter ? await handoff.inputFilter({ ...data, messages: [...transcript] }) : transcript;
  const messages = withMarker(forgetApprovals(filtered), toolCall.id, marker);
  await handoff.onHandoff?.({ ...data, ...(options.sessionId !== undefined && { sessionId: options.sessionId }) });
  const next = await extend(targetOptions(options, target));
  // The routing note stays in the transcript as a marked `system` message;
  // `withLeadingSystemOnly` (generateStep) folds it into the request's
  // leading system prompt so local-model chat templates never see a
  // mid-conversation system message.
  const system: Message[] = next.agent.prompt ? [{ role: 'system', content: next.agent.prompt }] : [];
  return { options: next, messages: [...system, ...messages], marker };
}
