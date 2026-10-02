/**
 * N6: handoffs inside one run. A handoff tool call is not executed as a tool:
 * once the other calls of its step are done, the run goes on in the same
 * `execute()` with the target agent's configuration (its agent, provider,
 * tools, skills, sub-agents, reasoning, guardrails, permission rules and own
 * handoffs) on the transcript the handoff's `inputFilter` returns, under the
 * target's own system prompt. Everything else (hooks, limits, `maxSteps`,
 * signal, stores, listeners, `output`, permission mode, principal) stays the
 * run's.
 *
 * The transcript records each handoff as `metadata.handoff = { from, to }`
 * on the handoff call's result (or, when an input filter dropped it, on the
 * last message kept). The marker is written in the same step as the switch,
 * so "the last marker names the active agent" holds for every checkpoint and
 * approval snapshot.
 */

import type { Message, ToolCall, ToolDefinition } from '../providers';
import type { StandardSchemaV1 } from '../utils/zodCompat';
import type { ExecuteOptions } from './AgentExecutor';
import type { SubagentSpec } from './delegation';
import type { AgentRunState } from './agentRunState';
import { ConfigurationError } from './errors';
import { runEventsOf } from './agentRun';
import { buildTools } from './generateStep';
import { toolErrorResult } from './toolErrors';
import { ToolArgumentsValidationError, parseToolArguments, parseWithIssues } from './toolArgsValidation';

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

/**
 * Inserts a tool result where the model's call order puts it among the
 * results that follow its assistant turn (appended when the turn is not found).
 */
export function insertToolResult(messages: Message[], result: Message): void {
  const id = result.toolCallId;
  let turn = messages.length - 1;
  while (turn >= 0 && !(messages[turn].role === 'assistant' && messages[turn].toolCalls?.some((call) => call.id === id))) turn--;
  if (turn === -1) {
    messages.push(result);
    return;
  }
  const order = new Map((messages[turn].toolCalls ?? []).map((call, index) => [call.id, index]));
  const mine = order.get(id ?? '') ?? 0;
  let at = turn + 1;
  while (at < messages.length && messages[at].role === 'tool' && (order.get(messages[at].toolCallId ?? '') ?? -1) < mine) at++;
  messages.splice(at, 0, result);
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

/** Why the first handoff call of a step cannot hand off, as the error result the model gets; or its parsed arguments. */
async function checkHandoffCall(
  options: Pick<ExecuteOptions, 'maxHandoffs'>,
  state: AgentRunState,
  handoff: ResolvedHandoff,
  toolCall: ToolCall
): Promise<{ error: Record<string, unknown> } | { args: Record<string, unknown> }> {
  const toolName = toolCall.function.name;
  const raw = parseToolArguments(toolCall, undefined);
  const parsed = raw === undefined ? undefined : await parseWithIssues(handoff.input, raw);
  if (!parsed?.success) {
    const issues = parsed?.issues ?? [{ path: '(root)', message: 'the arguments are not valid JSON' }];
    return { error: new ToolArgumentsValidationError(toolName, issues).toToolResult() };
  }
  const max = options.maxHandoffs ?? DEFAULT_MAX_HANDOFFS;
  if ((state.handoffs ?? 0) >= max) {
    const error = `No handoff: this run already handed off ${max} time${max === 1 ? '' : 's'} (maxHandoffs). Answer the user yourself.`;
    return { error: toolErrorResult({ toolName, error, kind: 'not-run' }) };
  }
  return { args: (parsed.data ?? {}) as Record<string, unknown> };
}

/**
 * Settles a step's handoff calls once its other calls are done: the first one
 * that passes its checks (arguments, `maxHandoffs`) is returned for the
 * switch; every other one gets an error result. Each gets its `tool.start`
 * here; the honored one's `tool.done` comes with the switch.
 */
export async function takeHandoffCalls(options: ExecuteOptions, state: AgentRunState, handoffCalls: readonly ToolCall[]): Promise<HonoredHandoff | undefined> {
  const sink = runEventsOf(options);
  let honored: HonoredHandoff | undefined;
  for (const [index, toolCall] of handoffCalls.entries()) {
    sink?.toolStart(toolCall);
    const handoff = handoffNamed(options, toolCall.function.name) as ResolvedHandoff;
    const toolName = toolCall.function.name;
    const checked =
      index === 0
        ? await checkHandoffCall(options, state, handoff, toolCall)
        : { error: toolErrorResult({ toolName, error: 'No handoff: only one handoff per turn is honored, and an earlier call of this turn handed off.', kind: 'not-run' }) };
    if ('args' in checked) {
      honored = { handoff, toolCall, args: checked.args };
      continue;
    }
    insertToolResult(state.messages, errorMessage(toolCall, checked.error));
    sink?.toolSettled({ toolCallId: toolCall.id, toolName, result: checked.error, error: String(checked.error.message) });
  }
  return honored;
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

/** The run's options with the target's configuration in place of the agent's that handed off. */
function targetOptions(options: ExecuteOptions, target: HandoffTarget): ExecuteOptions {
  return {
    ...options,
    agent: target.agent,
    provider: target.provider,
    toolRegistry: target.toolRegistry,
    hostedTools: target.hostedTools,
    skills: target.skills,
    subagents: target.subagents,
    reasoning: target.reasoning,
    guardrails: target.guardrails,
    permissions: target.permissions,
    handoffs: target.handoffs,
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
  state: AgentRunState,
  { handoff, toolCall, args }: HonoredHandoff,
  extend: (options: ExecuteOptions) => Promise<ExecuteOptions>
): Promise<{ options: ExecuteOptions; messages: Message[]; marker: HandoffMarker }> {
  const marker: HandoffMarker = { from: state.agentName ?? options.agent.name, to: handoff.name };
  const toolName = toolCall.function.name;
  const result: Message = { role: 'tool', content: JSON.stringify({ transferred_to: handoff.name }), name: toolName, toolCallId: toolCall.id, toolName, metadata: { handoff: marker } };
  const transcript = state.messages[0]?.role === 'system' ? state.messages.slice(1) : [...state.messages];
  insertToolResult(transcript, result);
  const target = await handoff.spec(lastUserText(transcript));
  const data: HandoffInputData = { messages: transcript, ...marker, args };
  const filtered = handoff.inputFilter ? await handoff.inputFilter({ ...data, messages: [...transcript] }) : transcript;
  const messages = withMarker(forgetApprovals(filtered), toolCall.id, marker);
  await handoff.onHandoff?.({ ...data, ...(options.sessionId !== undefined && { sessionId: options.sessionId }) });
  const next = await extend(targetOptions(options, target));
  const system: Message[] = next.agent.prompt ? [{ role: 'system', content: next.agent.prompt }] : [];
  return { options: next, messages: [...system, ...messages], marker };
}
