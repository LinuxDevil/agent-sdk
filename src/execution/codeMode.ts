/**
 * N14: code mode. With `createAgent({ codeMode })` the model gets a `run_code`
 * tool: it writes one short JavaScript program that calls the run's tools as
 * async functions, and only the program's return value enters the transcript.
 *
 * - `withCodeMode()` (applied by the executor when a run starts, after tool
 *   search) loads QuickJS, registers `run_code` with a signature per allowed
 *   tool in its description, and (`exclusive`) takes the allowed tools off the
 *   model's tool list. They stay in the registry, callable from scripts.
 * - Every `tools.x(args)` of a script is an inner tool call: a synthetic
 *   `ToolCall` (id `<run_code call id>:<n>`) that goes through `runToolCall()`
 *   with the run's context, so validation, hooks, permission rules and modes,
 *   guardrails, `needsApproval`, sandbox routing and the principal all apply.
 *   Its events carry `parentToolCallId`. A call that would pause the run (for
 *   approval, a sign-in or a sub-agent's approval) is refused inside the script
 *   instead: an isolate cannot be checkpointed and resumed.
 * - The script itself runs in `codeModeIsolate.ts`.
 */

import { z } from 'zod';
import type { ToolCall, ToolDefinition } from '../providers';
import type { AgentConfig } from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { getToolExecute } from '../tools/toolContract';
import { ConfigurationError, SDKError } from './errors';
import { buildTools } from './generateStep';
import { extendAgent, toolCallScopeOf, type ToolCallScope } from './subagentRuntime';
import { markPropagating } from './propagatingToolError';
import { runToolCall, type ToolCallContext, type ToolCallOutcome } from './toolCallExecution';
import { Limiter, type ToolConcurrency } from './toolBatch';
import { runEventsOf } from './agentRun';
import { withSpan, type TraceExporter } from './tracing';
import { recordToolOutcome, resolveCaptureContent, toolSpanInit } from './genAiSpans';
import { SdkAttr } from './semconv';
import { jsonSchemaOf } from './toolSearch';
import { TOOL_SEARCH_TOOL, type ToolDeferral } from './toolDeferral';
import { ASK_QUESTION_TOOL_NAME } from './ApprovalGate';
import { loadQuickJS, runScript, type ScriptLimits, type ScriptToolResult } from './codeModeIsolate';
import type { ExecuteOptions } from './AgentExecutor';

/**
 * Code mode (`createAgent({ codeMode })`): the model gets a `run_code` tool
 * whose script calls the agent's tools as async functions. See docs/code-mode.md.
 *
 * @example
 * ```ts
 * createAgent({ model: 'openai/gpt-4o-mini', tools: [getPrice, convert], codeMode: { tools: ['get_price', 'convert'], timeoutMs: 10_000 } });
 * ```
 */
export interface CodeModeOptions {
  /** Tool names the script may call. Default: every tool of the run except `run_code`, `ask_question`, sub-agent tools, `tool_search`, `load_skill` and deferred tools. */
  tools?: readonly string[];
  /** Default false. True hides those tools from the model, so it must call them through `run_code`. */
  exclusive?: boolean;
  /** Default 30,000: for the whole script, including the tool calls it awaits. */
  timeoutMs?: number;
  /** Default 64 MiB: the isolate's memory. */
  memoryLimitBytes?: number;
  /** Default 50 tool calls per script. */
  maxToolCalls?: number;
  /** Default 20,000 characters for the returned value (as JSON) plus logs. */
  maxOutputChars?: number;
}

/** The name of the code mode tool. */
export const RUN_CODE_TOOL = 'run_code';

const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxToolCalls: 50,
  maxOutputChars: 20_000,
};

/** Tools a script cannot call unless `codeMode.tools` names them: ones that ask the user, start sub-agents or load other tools. */
const NOT_BY_DEFAULT = new Set([ASK_QUESTION_TOOL_NAME, 'task', 'agent_status', 'agent_await', 'agent_cancel', TOOL_SEARCH_TOOL, 'load_skill']);
const isDelegateTool = (name: string) => name.startsWith('delegate_to_');

/** What is wrong with one `codeMode` option's value (undefined: nothing), per option. */
const OPTION_CHECKS: Record<string, (value: unknown) => string | undefined> = {
  tools: (tools) => {
    if (!Array.isArray(tools) || !tools.every((name) => typeof name === 'string')) return 'must be an array of tool names';
    return tools.includes(RUN_CODE_TOOL) ? `cannot name '${RUN_CODE_TOOL}' itself` : undefined;
  },
  exclusive: (exclusive) => (typeof exclusive === 'boolean' ? undefined : 'must be a boolean'),
  timeoutMs: wholeNumber,
  memoryLimitBytes: wholeNumber,
  maxToolCalls: wholeNumber,
  maxOutputChars: wholeNumber,
};

function wholeNumber(value: unknown): string | undefined {
  return Number.isInteger(value) && (value as number) >= 1 ? undefined : `must be a whole number >= 1, got ${String(value)}`;
}

/** Throws `LOUSHO_CONFIG_INVALID` unless `value` is a valid `codeMode` option. */
export function assertCodeModeOptions(value: unknown, where: string): void {
  if (value === undefined || typeof value === 'boolean') return;
  const problem = codeModeProblem(value);
  if (problem) throw new ConfigurationError(`${where}: ${problem}. See docs/code-mode.md.`, 'codeMode');
}

/** What is wrong with a `codeMode` object, if anything. */
function codeModeProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `'codeMode' must be true, false or an object, got ${String(value)}`;
  for (const [key, option] of Object.entries(value)) {
    const check = OPTION_CHECKS[key];
    if (!check) return `'codeMode.${key}' is not an option`;
    const problem = option === undefined ? undefined : check(option);
    if (problem) return `'codeMode.${key}' ${problem}`;
  }
  return undefined;
}

/** Where a run's code mode rides on its options (set by `createAgent()`; spreading the options keeps it). */
const CODE_MODE: unique symbol = Symbol('lousho.codeMode');

type CodeModeRun = { [CODE_MODE]?: CodeModeOptions };

/** The run-options entry that turns code mode on (empty for `false` / `undefined`). */
export function codeModeOption(codeMode: boolean | CodeModeOptions | undefined): CodeModeRun {
  if (!codeMode) return {};
  return { [CODE_MODE]: codeMode === true ? {} : codeMode };
}

/** The code mode of a run, if it has one. */
export function codeModeOf(options: object): CodeModeOptions | undefined {
  return (options as CodeModeRun)[CODE_MODE];
}

/**
 * The tools a script of this run may call: `codeMode.tools` (the ones the run
 * has), or every tool of the run but the ones in {@link NOT_BY_DEFAULT},
 * delegate tools and deferred tools.
 */
function allowedTools(codeMode: CodeModeOptions, agent: AgentConfig, toolRegistry: ToolRegistry | undefined, deferral: ToolDeferral | undefined): ToolDefinition[] {
  const callable = buildTools(agent, toolRegistry).filter(({ function: { name } }) => {
    const descriptor = toolRegistry?.get(name);
    return name !== RUN_CODE_TOOL && descriptor !== undefined && getToolExecute(descriptor) !== undefined;
  });
  if (codeMode.tools) {
    const named = new Set(codeMode.tools);
    return callable.filter(({ function: { name } }) => named.has(name));
  }
  return callable.filter(({ function: { name } }) => !NOT_BY_DEFAULT.has(name) && !isDelegateTool(name) && !deferral?.deferred.has(name));
}

/**
 * Applies code mode to a run (a no-op without it): loads QuickJS (so a missing
 * `quickjs-emscripten` fails the run at its start), registers `run_code` in a
 * copy of the registry and, with `exclusive`, takes the allowed tools off the
 * agent's tool list.
 */
export async function withCodeMode(
  options: ExecuteOptions,
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  deferral: ToolDeferral | undefined
): Promise<{ agent: AgentConfig; toolRegistry: ToolRegistry | undefined }> {
  const codeMode = codeModeOf(options);
  if (!codeMode) return { agent, toolRegistry };
  await loadQuickJS();
  if (toolRegistry?.has(RUN_CODE_TOOL) || agent.tools?.[RUN_CODE_TOOL]) {
    throw new ConfigurationError(
      `Agent '${agent.name}': a tool named '${RUN_CODE_TOOL}' is already registered, but code mode adds one. Rename your tool, or turn codeMode off.`,
      'codeMode'
    );
  }
  const allowed = allowedTools(codeMode, agent, toolRegistry, deferral);
  const registry = new ToolRegistry();
  for (const [name, descriptor] of Object.entries(toolRegistry?.getAll() ?? {})) registry.register(name, descriptor);
  registry.register(runCodeTool(allowed, codeMode));
  const hidden = new Set(codeMode.exclusive ? allowed.map(({ function: { name } }) => name) : []);
  const tools = Object.fromEntries(Object.entries(agent.tools ?? {}).filter(([name]) => !hidden.has(name)));
  return { agent: extendAgent(agent, { tools: { ...tools, [RUN_CODE_TOOL]: { tool: RUN_CODE_TOOL } } }), toolRegistry: registry };
}

/** The script limits of `codeMode`, defaults filled in. */
function limitsOf(codeMode: CodeModeOptions): ScriptLimits {
  return {
    timeoutMs: codeMode.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    memoryLimitBytes: codeMode.memoryLimitBytes ?? DEFAULT_LIMITS.memoryLimitBytes,
    maxToolCalls: codeMode.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    maxOutputChars: codeMode.maxOutputChars ?? DEFAULT_LIMITS.maxOutputChars,
  };
}

/** What `run_code` returns. */
interface RunCodeResult {
  result: unknown;
  logs: string[];
  toolCalls: number;
}

/** The `run_code` tool over `allowed`. Its inner calls go through the calling run's {@link ToolCallScope.callTool}. */
function runCodeTool(allowed: readonly ToolDefinition[], codeMode: CodeModeOptions): DefinedTool {
  const limits = limitsOf(codeMode);
  const toolNames = allowed.map(({ function: { name } }) => name);
  return defineTool({
    name: RUN_CODE_TOOL,
    description: runCodeDescription(allowed, limits),
    input: z.object({ code: z.string().describe('The body of an async JavaScript function: call tools with await tools.<name>({ ... }) and return the result') }),
    // N4: run_code itself changes nothing; each inner call passes the permission mode on its own (plan mode refuses non-read-only ones).
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async ({ code }, ctx): Promise<RunCodeResult> => {
      const callTool = toolCallScopeOf(ctx)?.callTool;
      if (!callTool) throw new SDKError(`${RUN_CODE_TOOL} can only run as a tool call of an agent run with codeMode.`, 'LOUSHO_CONFIG_INVALID');
      const module = await loadQuickJS();
      return runScript(module, code, { toolNames, callTool, signal: ctx.abortSignal }, limits);
    },
  });
}

/** `run_code`'s description: what a script can do, its limits, and a signature per allowed tool. */
function runCodeDescription(allowed: readonly ToolDefinition[], limits: ScriptLimits): string {
  const signatures = allowed.length > 0 ? allowed.map(toolSignature).join('\n') : '(none)';
  return [
    'Runs a short JavaScript program in a sandbox. Use it to call several tools in one step: loop over them, filter and combine their results in code, and return only what you need.',
    'The code is the body of an async function. Call a tool with `await tools.<name>({ ...args })`: it resolves to the tool\'s result, or throws an Error with the tool\'s error message. `return` a JSON-serializable value: it is the result. `console.log()` lines come back as `logs`.',
    'Tool results have no declared type: when you do not know the shape of a result, return it (or console.log it) and read it before you compute with it.',
    `No network, file system, timers, require or import. Limits: ${limits.timeoutMs} ms, ${limits.maxToolCalls} tool calls, ${limits.maxOutputChars} characters of output. A tool that needs approval or a sign-in cannot be called from a script: call it directly.`,
    'Available tools:',
    signatures,
  ].join('\n');
}

/** One allowed tool as a TypeScript-like signature with its description as a comment. */
function toolSignature({ function: fn }: ToolDefinition): string {
  const description = fn.description.replace(/\s+/g, ' ').trim();
  const comment = description ? `// ${description.length > 200 ? `${description.slice(0, 197)}...` : description}\n` : '';
  return `${comment}tools.${fn.name}(args: ${renderSchema(jsonSchemaOf(fn.parameters), 0)}): Promise<unknown>`;
}

type JsonSchema = {
  type?: unknown;
  enum?: unknown[];
  const?: unknown;
  items?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  description?: unknown;
};

const SCALARS: Record<string, string> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', null: 'null' };

/** A JSON Schema as a TypeScript-like type; what it cannot render is `unknown`. */
function renderSchema(schema: unknown, depth: number): string {
  if (typeof schema !== 'object' || schema === null || depth > 4) return 'unknown';
  const s = schema as JsonSchema;
  return renderValues(s) ?? renderUnion(s, depth) ?? renderTyped(s, depth);
}

/** A `const` or an `enum` as literal types. */
function renderValues(s: JsonSchema): string | undefined {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((value) => JSON.stringify(value)).join(' | ') || 'unknown';
  return undefined;
}

/** `anyOf` / `oneOf`, or a list of `type`s, as a union. */
function renderUnion(s: JsonSchema, depth: number): string | undefined {
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map((member) => renderSchema(member, depth + 1)).join(' | ') || 'unknown';
  if (Array.isArray(s.type)) return s.type.map((type) => renderSchema({ ...s, type }, depth)).join(' | ');
  return undefined;
}

/** A scalar, an array or an object type. */
function renderTyped(s: JsonSchema, depth: number): string {
  if (typeof s.type === 'string' && SCALARS[s.type]) return SCALARS[s.type];
  if (s.type === 'array') {
    const item = renderSchema(s.items, depth + 1);
    return item.includes(' ') ? `Array<${item}>` : `${item}[]`;
  }
  if (s.type === 'object' || s.properties) return renderObject(s, depth);
  return 'unknown';
}

function renderObject(s: JsonSchema, depth: number): string {
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const fields = Object.entries(s.properties ?? {}).map(([key, value]) => {
    const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    return `${name}${required.has(key) ? '' : '?'}: ${renderSchema(value, depth + 1)}`;
  });
  return fields.length > 0 ? `{ ${fields.join('; ')} }` : 'Record<string, unknown>';
}

/** Runs one inner tool call of a script (see {@link ToolCallScope.callTool}). */
export type NestedToolCaller = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ScriptToolResult>;

/** What {@link nestedToolCaller} needs from the run and the `run_code` call. */
export interface NestedCallSetup {
  /** The `run_code` call. */
  parentToolCallId: string;
  /** Its `execute_tool` span: inner calls' spans are its children. */
  parentSpanId?: string;
  /** The context inner calls run with (the outer call's, minus what is per inner call). */
  base: Omit<ToolCallContext, 'signal' | 'scope' | 'onToolPartial'>;
  /** The run's signal. */
  signal?: AbortSignal;
  /** The run options an inner call's scope carries (permission rules and modes, guardrails, events, sub-agents). */
  runtime: ToolCallScope['runtime'];
  /** Runs a child agent (a sub-agent an inner call starts). */
  execute: ToolCallScope['execute'];
  tracing: { exporter?: TraceExporter; redactContent?: boolean; captureContent?: ExecuteOptions['captureContent'] };
  /** The run's `toolConcurrency`: how many inner calls of one script run at once (`Promise.all`). */
  concurrency: ToolConcurrency;
}

/**
 * The inner-call runner of one `run_code` call. Each call gets the id
 * `<parent>:<n>`, its own `execute_tool` span under the parent's, and
 * `tool.start` / `tool.done` / `tool.error` events with `parentToolCallId`.
 * A call that would pause the run settles as an error the script sees. A
 * fatal error (a guardrail block, a hook error) propagates and ends the run,
 * as it does for a direct call.
 */
export function nestedToolCaller(setup: NestedCallSetup): NestedToolCaller {
  const { parentToolCallId: parent, base, tracing } = setup;
  const limiter = new Limiter(setup.concurrency === 'unbounded' ? Infinity : setup.concurrency);
  const sink = runEventsOf(setup.runtime);
  let count = 0;
  return async (name, args, scriptSignal) => {
    const toolCall: ToolCall = { id: `${parent}:${++count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    await limiter.acquire();
    try {
      sink?.toolStart(toolCall, parent);
      const signal = setup.signal ? AbortSignal.any([setup.signal, scriptSignal]) : scriptSignal;
      const init = toolSpanInit({ id: toolCall.id, name }, { agent: base.agent, toolRegistry: base.toolRegistry, sessionId: base.sessionId });
      const outcome = await withSpan(
        tracing.exporter,
        init.name,
        { ...init.attributes, [SdkAttr.PARENT_TOOL_CALL_ID]: parent },
        async (span) => {
          const started = Date.now();
          const scope: ToolCallScope = { runtime: setup.runtime, toolCallId: toolCall.id, spanId: span.id, execute: setup.execute };
          const onToolPartial = sink && ((id: string, toolName: string, output: unknown) => sink.toolPartial(id, toolName, output, parent));
          const settled = inScript(await runToolCall(toolCall, { ...base, signal, scope, ...(onToolPartial && { onToolPartial }) }));
          recordToolOutcome(
            span,
            { args: settled.args ?? args, result: settled.result, error: settled.error, latencyMs: Date.now() - started },
            { redactContent: tracing.redactContent, captureContent: resolveCaptureContent(tracing.captureContent) }
          );
          return settled;
        },
        setup.parentSpanId,
        init.kind
      );
      sink?.toolSettled(outcome, parent);
      return outcome.error === undefined ? { json: toJson(outcome.result) } : { error: outcome.error };
    } catch (error) {
      // Fatal for the run, like the same error from a direct call (the batch stops on it).
      markPropagating(error);
      throw error;
    } finally {
      limiter.release();
    }
  };
}

/** An inner call's outcome as the script gets it: a call that would pause the run is an error instead. */
function inScript(outcome: ToolCallOutcome): ToolCallOutcome {
  const { toolName } = outcome;
  const refused = (error: string): ToolCallOutcome => ({ toolCallId: outcome.toolCallId, toolName, result: { error: 'ToolError', toolName, message: error, kind: 'not-run' }, error, args: outcome.args });
  if (outcome.requiresApproval) return refused(`Tool ${toolName} needs approval; call it directly, not from run_code.`);
  if (outcome.signIn) {
    return refused(`Tool ${toolName} needs the user to sign in to ${outcome.signIn.provider.displayName}; call it directly, not from run_code.`);
  }
  if (outcome.subagent) return refused(`Tool ${toolName} started a sub-agent that needs approval; call it directly, not from run_code.`);
  return outcome;
}

/** A tool result as JSON (`undefined` -> `null`; an unserializable value -> its string form). */
function toJson(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value) ?? 'null';
  } catch {
    return JSON.stringify(String(value));
  }
}
