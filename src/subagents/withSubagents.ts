/**
 * The `subagents` option (LOU-Y3): registers ONE `task` tool through which a
 * lead agent delegates work to named sub-agents, and lists them (name +
 * description) in the lead's system prompt. Sub-agents run through the
 * shared delegation core (`runSubagent()`), so they inherit the lead run's
 * runtime (LOU-Y1).
 */

import { z } from 'zod';
import type { AgentConfig } from '../types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { withPromptTool } from '../skills/withSkills';
import type { Message } from '../providers';
import { newId } from '../utils/id';
import { runSubagent, type SubagentSpec } from '../execution/delegation';
import { bindToolCallScope, extendAgent, SubagentApprovalPause, subagentBudget, toolCallScopeOf } from '../execution/subagentRuntime';
import { isPropagatingToolError } from '../execution/propagatingToolError';
import type { ExecuteOptions, ExecutionResult } from '../execution/AgentExecutor';
import type { RemoteSubagent, SubagentCatalog, SubagentSummary, Subagents } from './types';
import { isRemoteSubagent } from './remoteAgent';
import { anyError } from '../utils/zodCompat';
import { BackgroundTasks, subagentOptionsOf, withSubagentOptions, type SubagentOptions } from './backgroundTasks';
import { busy, taskNotFound, TaskSessions, type TaskMode, type TaskRecord } from './taskSessions';

/** Name of the tool the lead model delegates with. */
const TASK_TOOL = 'task';
/** Tools that observe and steer background tasks (LOU-Y4), registered with `task`. */
const BACKGROUND_TOOLS = ['agent_status', 'agent_await', 'agent_cancel'] as const;

/** Same default as `ExecuteOptions.maxSteps`. */
const DEFAULT_MAX_STEPS = 10;

/** An agent usable as a sub-agent: its run configuration and description. */
interface RegisteredSubagent {
  /** A function for an agent whose config is resolved per run (LOU-V15): called with the task prompt. */
  spec: SubagentSpec | ((prompt: string) => Promise<SubagentSpec>);
  description?: string;
}

/** A sub-agent to run: a local one by its spec, or a deployed one (LOU-Y7). */
type ResolvedSubagent = RegisteredSubagent | { remote: RemoteSubagent; description: string };

const registeredSubagents = new WeakMap<object, RegisteredSubagent>();

/** Makes `agent` (a `createAgent()` result) usable as a sub-agent. */
export function registerSubagent(agent: object, registration: RegisteredSubagent): void {
  registeredSubagents.set(agent, registration);
}

function isCatalog(subagents: Subagents): subagents is SubagentCatalog {
  const candidate = subagents as Partial<SubagentCatalog>;
  return typeof candidate.list === 'function' && typeof candidate.resolve === 'function';
}

function registrationOf(agent: unknown, name: string, caller: string): ResolvedSubagent {
  if (isRemoteSubagent(agent)) return { remote: agent, description: agent.description };
  const registration = typeof agent === 'object' && agent !== null ? registeredSubagents.get(agent) : undefined;
  if (!registration) {
    throw new Error(
      `${caller}: sub-agent '${name}' is not an agent created with createAgent(). ` +
        `Example: subagents: { ${name}: createAgent({ instructions, description, provider }) }`
    );
  }
  return registration;
}

/**
 * Throws a descriptive error unless `value` is a valid `maxSubagentDepth`
 * (`undefined` means "use the default" and is accepted).
 */
export function assertMaxSubagentDepth(value: unknown, caller: string): void {
  if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
    return;
  }
  throw new Error(
    `${caller}: 'maxSubagentDepth' must be a whole number >= 0, got ${String(value)}. ` +
      'Use 1 (the default) to let only the lead agent delegate, 2 to let its sub-agents delegate too.'
  );
}

/**
 * Checks a `subagents` option up front: every agent of a record must come
 * from createAgent() and have a `description`. A catalog is checked per run.
 */
export function assertSubagents(subagents: Subagents | undefined, caller: string): void {
  if (!subagents || isCatalog(subagents)) {
    return;
  }
  for (const [name, agent] of Object.entries(subagents)) {
    if (!registrationOf(agent, name, caller).description?.trim()) {
      throw new Error(
        `${caller}: sub-agent '${name}' has no description. The lead model picks a sub-agent by its description - ` +
          `add one: createAgent({ ..., description: 'Finds and summarizes sources' }).`
      );
    }
  }
}

function assertSummaries(summaries: readonly SubagentSummary[]): void {
  const seen = new Set<string>();
  for (const { name, description } of summaries) {
    if (!name || seen.has(name)) {
      throw new Error(`subagents: catalog list() returned ${name ? `the name '${name}' twice` : 'an empty name'}. Names must be unique and non-empty.`);
    }
    if (!description?.trim()) {
      throw new Error(`subagents: catalog list() returned sub-agent '${name}' without a description. Add one so the lead model can pick it.`);
    }
    seen.add(name);
  }
}

/**
 * `createAgent({ subagentOptions })`: a copy of `subagents` with `options`
 * over the ones attached with `withSubagentOptions()` (the caller's value is
 * left as is, so it can be shared between agents).
 */
export function subagentsWithOptions(subagents: Subagents | undefined, options: SubagentOptions | undefined): Subagents | undefined {
  if (!subagents || !options) return subagents;
  const copy: Subagents = isCatalog(subagents)
    ? { list: () => subagents.list(), resolve: (name) => subagents.resolve(name) }
    : { ...subagents };
  return withSubagentOptions(copy, { ...subagentOptionsOf(subagents), ...options });
}

async function listSubagents(subagents: Subagents): Promise<SubagentSummary[]> {
  if (isCatalog(subagents)) {
    const summaries = [...(await subagents.list())];
    assertSummaries(summaries);
    return summaries;
  }
  assertSubagents(subagents, 'subagents');
  return Object.entries(subagents).map(([name, agent]) => ({
    name,
    description: registrationOf(agent, name, 'subagents').description ?? '',
  }));
}

async function resolveSubagent(subagents: Subagents, name: string, names: readonly string[]): Promise<ResolvedSubagent> {
  const agent = !names.includes(name)
    ? undefined
    : isCatalog(subagents)
      ? await subagents.resolve(name)
      : subagents[name];
  if (!agent) {
    throw new Error(`Unknown sub-agent '${name}'. Valid sub-agents: ${names.join(', ')}.`);
  }
  return registrationOf(agent, name, 'task');
}

function subagentsPromptBlock(summaries: readonly SubagentSummary[]): string {
  return [
    '## Available sub-agents',
    '',
    `Delegate a self-contained task to one of these with the \`${TASK_TOOL}\` tool. A sub-agent sees only the prompt you give it, not this conversation, so include everything it needs. Several \`${TASK_TOOL}\` calls in one turn run in parallel. With \`background: true\` a task runs while you keep working: check it with \`agent_status\`, collect its answer with \`agent_await\` before you finish, or stop it with \`agent_cancel\`. Every result ends with a taskId: pass it back as \`taskId\` to ask that sub-agent a follow-up with its earlier work in context, or with \`mode: 'fork'\` to branch a copy of that conversation.`,
    '',
    ...summaries.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}

/** Why a sub-agent run that did not finish normally failed. */
function failureReason(name: string, result: ExecutionResult, maxSteps: number): string {
  const last = result.text ? ` Its last text: ${result.text}` : '';
  if (result.finishReason === 'output-invalid') {
    return `Sub-agent '${name}' did not return a valid object for its output schema: ${result.outputError?.message ?? 'unknown problem'}. Retry the task, or adapt.${last}`;
  }
  if (result.finishReason === 'aborted') {
    return `Sub-agent '${name}' was aborted before it finished.${last}`;
  }
  if (result.finishReason === 'max-steps' || result.steps >= maxSteps) {
    return `Sub-agent '${name}' used all ${maxSteps} of its steps (maxSteps) without giving a final answer.${last}`;
  }
  return `Sub-agent '${name}' ended with finish reason '${result.finishReason}' without a final answer.${last}`;
}

/**
 * The `task` tool result: the sub-agent's final text plus a metadata footer. A sub-agent with an `output` schema
 * (LOU-V4.2) answers with its validated object as JSON in place of the text, then the same footer. Throws when it did not finish.
 */
function taskResult(name: string, result: ExecutionResult, maxSteps: number, taskId: string): string {
  if (result.finishReason !== 'stop' && result.finishReason !== 'length') {
    throw new Error(failureReason(name, result, maxSteps));
  }
  const footer = `[sub-agent '${name}': ${result.steps} step(s), finish reason '${result.finishReason}', taskId '${taskId}']`;
  const body = result.object === undefined ? result.text : JSON.stringify(result.object);
  return body ? `${body}\n\n${footer}` : footer;
}

type TaskArgs = { agent: string; prompt: string; description: string; background?: boolean; taskId?: string; mode?: TaskMode };
type ToolOptions = { abortSignal?: AbortSignal } | undefined;

/** The child conversation a `task` call runs in (LOU-Y6). */
interface ChildTask {
  taskId: string;
  /** The earlier turns of a resumed or forked task. */
  history: Message[];
  remoteSessionId?: string;
  save: (record: TaskRecord) => Promise<void>;
}

/** The transcript (without the system prompt) of a child run that can be continued. */
function transcriptOf(result: ExecutionResult): Message[] | undefined {
  if (!['stop', 'length', 'max-steps'].includes(result.finishReason)) return undefined;
  return result.messages[0]?.role === 'system' ? result.messages.slice(1) : result.messages;
}

async function runTask(registered: RegisteredSubagent['spec'], args: TaskArgs, toolOptions: ToolOptions, task: ChildTask): Promise<string> {
  let spec: SubagentSpec;
  let result: ExecutionResult;
  try {
    spec = typeof registered === 'function' ? await registered(args.prompt) : registered;
    result = await runSubagent(spec, {
      name: args.agent,
      input: [...task.history, { role: 'user', content: args.prompt }],
      toolOptions,
      description: args.description,
    });
  } catch (error) {
    // A paused child: on resume this call is re-entered with the taskId it saves under.
    if (error instanceof SubagentApprovalPause) error.resumeArgs = { taskId: task.taskId };
    if (isPropagatingToolError(error)) throw error;
    throw new Error(`Sub-agent '${args.agent}' failed: ${(error as Error | undefined)?.message ?? String(error)}`);
  }
  const messages = transcriptOf(result);
  if (messages) await task.save({ messages });
  return taskResult(args.agent, result, spec.maxSteps ?? DEFAULT_MAX_STEPS, task.taskId);
}

/** The tool options a background child runs with: the same parent run, its own abort signal. */
function withAbortSignal(toolOptions: ToolOptions, abortSignal: AbortSignal): { abortSignal: AbortSignal } {
  const options = { ...toolOptions, abortSignal };
  bindToolCallScope(options, toolCallScopeOf(toolOptions));
  return options;
}

/**
 * A deployed sub-agent's task: its final text, or a thrown coded error (never wrapped, so the code stays visible).
 * A resumed task continues in its remote session (LOU-Y7.2), saved up front so a task whose remote run paused for
 * approval can be continued. LOU-Y7.3: with an approval store, a remote pause pauses the lead; re-entered on resume,
 * the call decides the remote approval its suspension recorded (remote session id, approval id) with the lead's decision.
 */
async function runRemoteTask(remote: RemoteSubagent, args: TaskArgs, toolOptions: ToolOptions, task: ChildTask): Promise<string> {
  const scope = toolCallScopeOf(toolOptions);
  const paused = scope?.resume && { snapshot: scope.resume.suspension.snapshot, decision: scope.resume.decision };
  const sessionId = paused?.snapshot.sessionId ?? task.remoteSessionId ?? newId('task');
  await task.save({ messages: [], remoteSessionId: sessionId });
  const decision = paused && { approvalId: paused.snapshot.pendingToolCall.id, approved: paused.decision.approved, note: paused.decision.note };
  const pausable = scope?.runtime.approvalStore !== undefined;
  try {
    return await remote.run(args.prompt, { name: args.agent, signal: toolOptions?.abortSignal, sessionId, taskId: task.taskId, pausable, decision });
  } catch (error) {
    if (error instanceof SubagentApprovalPause) error.resumeArgs = { taskId: task.taskId };
    throw error;
  }
}

/** What the `task` tool of one run works with. */
interface TaskContext {
  subagents: Subagents;
  names: readonly string[];
  background: BackgroundTasks;
  sessions: TaskSessions;
}

/**
 * The child conversation of a `task` call (LOU-Y6): a new one, the one of
 * `taskId` (resume), or a new one starting from a copy of it (fork). A call
 * re-entered after an approval keeps the taskId it paused with.
 */
async function openTask(ctx: TaskContext, args: TaskArgs, reentered: boolean): Promise<ChildTask> {
  const child = (taskId: string, record?: TaskRecord): ChildTask => ({
    taskId,
    history: record?.messages ?? [],
    remoteSessionId: record?.remoteSessionId,
    save: (saved) => ctx.sessions.save(taskId, args.agent, saved),
  });
  const mode = args.mode ?? (args.taskId === undefined ? 'new' : 'resume');
  if (reentered && args.taskId) return child(args.taskId);
  if (mode === 'new') return child(await ctx.sessions.allocate());
  if (args.taskId === undefined) throw taskNotFound(`mode '${mode}' needs the taskId of an earlier task.`);
  if (ctx.background.isActive(args.taskId)) throw busy(args.taskId);
  const record = await ctx.sessions.load(args.taskId, args.agent);
  if (mode === 'resume') return child(args.taskId, record);
  if (record.remoteSessionId) throw new Error(`Task '${args.taskId}' ran on a remote agent, whose session cannot be copied: use mode 'resume' or 'new'.`);
  return child(await ctx.sessions.allocate(), record);
}

async function startTask(ctx: TaskContext, args: TaskArgs, toolOptions: ToolOptions): Promise<unknown> {
  const resolved = await resolveSubagent(ctx.subagents, args.agent, ctx.names);
  const task = await openTask(ctx, args, toolCallScopeOf(toolOptions)?.resume !== undefined);
  const run = (options: ToolOptions) =>
    ctx.sessions.run(task.taskId, () =>
      'remote' in resolved ? runRemoteTask(resolved.remote, args, options, task) : runTask(resolved.spec, args, options, task)
    );
  if (!args.background) {
    return run(toolOptions);
  }
  const { taskId, status, agent } = ctx.background.start(
    task.taskId,
    args.agent,
    (signal) => run(withAbortSignal(toolOptions, signal)),
    toolOptions?.abortSignal
  );
  return { taskId, status, agent };
}

/** The `agent` argument's error, the same on both zod majors: the name given and the valid ones. */
function unknownSubagent(names: readonly string[]): (input: unknown) => string {
  const valid = names.map((name) => `'${name}'`).join(', ');
  return (input) => (input === undefined ? 'Required' : `Unknown sub-agent ${JSON.stringify(input)}. Expected one of: ${valid}`);
}

function createTaskTool(ctx: TaskContext): DefinedTool {
  return defineTool({
    name: TASK_TOOL,
    description:
      'Delegate a self-contained task to a sub-agent listed under "Available sub-agents" and get its final answer back. ' +
      'The sub-agent sees only your prompt, not this conversation. The result ends with a taskId: pass it back as taskId ' +
      'to send that sub-agent a follow-up with its earlier work still in context, or with mode "fork" to branch a copy of it.',
    input: z.object({
      agent: z.enum(ctx.names as [string, ...string[]], anyError(unknownSubagent(ctx.names))).describe('Name of the sub-agent, exactly as listed'),
      prompt: z.string().describe('Complete instructions for the sub-agent, including all context it needs'),
      description: z.string().describe('A short (3-5 word) label for this task'),
      background: z
        .boolean()
        .optional()
        .describe('true: start the sub-agent and return a taskId at once; collect the answer later with agent_await'),
      taskId: z.string().optional().describe('The taskId of an earlier task of the same agent, to continue (or fork) it'),
      mode: z
        .enum(['new', 'resume', 'fork'])
        .optional()
        .describe("'new' (default without taskId): a fresh sub-agent. 'resume' (default with taskId): continue that task. 'fork': a new task starting from a copy of it"),
    }),
    execute: (args, options) => startTask(ctx, args, options),
  });
}

function createBackgroundTools(background: BackgroundTasks): DefinedTool[] {
  const taskId = z.string().describe('The taskId returned by task with background: true');
  return [
    defineTool({
      name: 'agent_status',
      description: 'Status of one background task, or of all of them: queued, running, done, failed, cancelled or awaiting-approval, with elapsedMs.',
      input: z.object({ taskId: taskId.optional() }),
      execute: ({ taskId: id }) => ({ tasks: background.status(id) }),
    }),
    defineTool({
      name: 'agent_await',
      description: "Waits for background tasks and returns each one's answer (or failure). Tasks still running after timeoutMs report status 'timeout'.",
      input: z.object({
        taskId: taskId.optional(),
        taskIds: z.array(z.string()).optional().describe('Several taskIds to wait for'),
        timeoutMs: z.number().int().positive().optional().describe('Stop waiting after this many milliseconds'),
      }),
      execute: async (args, ctx) => {
        const ids = args.taskIds ?? (args.taskId === undefined ? [] : [args.taskId]);
        if (ids.length === 0) throw new Error('agent_await: pass taskId or taskIds.');
        const views = await background.wait(ids, args.timeoutMs, ctx.abortSignal);
        return args.taskIds ? { tasks: views } : views[0];
      },
    }),
    defineTool({
      name: 'agent_cancel',
      description: 'Cancels a queued or running background task.',
      input: z.object({ taskId }),
      execute: ({ taskId: id }) => background.cancel(id),
    }),
  ];
}

/** Throws when the agent already has a tool named `task` (or one of the background-task tools). */
export function assertNoTaskTool(agent: AgentConfig, toolRegistry: ToolRegistry | undefined): void {
  const taken = [TASK_TOOL, ...BACKGROUND_TOOLS].find((name) => toolRegistry?.has(name) || agent.tools?.[name]);
  if (taken) {
    throw new Error(
      `subagents: a tool named '${taken}' is already registered, but agents with sub-agents get one automatically. ` +
        `Rename your tool, or remove the 'subagents' option.`
    );
  }
}

type OnRunEnd = ExecuteOptions['onRunEnd'];

/**
 * The run's `onRunEnd` (LOU-Y4.2): first cancels (or, with
 * `awaitBackgroundOnFinish`, awaits) the background tasks still active and
 * reports them on `result.backgroundTasks`, then calls `next`.
 */
function endBackgroundTasks(background: BackgroundTasks, awaitAll: boolean, next: OnRunEnd): NonNullable<OnRunEnd> {
  return async (end) => {
    const tasks = await background.finish(awaitAll && end.result !== undefined);
    if (end.result && tasks.length > 0) end.result.backgroundTasks = tasks;
    await next?.(end);
  };
}

/**
 * Applies `subagents` to an agent run: adds the `task` tool and the
 * "Available sub-agents" prompt block - unless this run is already at the
 * sub-agent depth limit (see `maxSubagentDepth`), or the catalog is empty -
 * and wraps `onRunEnd` so the run's background tasks end with it.
 * Inputs are not mutated.
 */
export async function withSubagents(
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  subagents: Subagents | undefined,
  run: Pick<ExecuteOptions, 'maxSubagentDepth' | 'onRunEnd' | 'sessionId'>
): Promise<{ agent: AgentConfig; toolRegistry: ToolRegistry | undefined; onRunEnd: OnRunEnd }> {
  const { onRunEnd } = run;
  if (!subagents || subagentBudget(run.maxSubagentDepth) <= 0) {
    return { agent, toolRegistry, onRunEnd };
  }
  assertNoTaskTool(agent, toolRegistry);
  const summaries = await listSubagents(subagents);
  if (summaries.length === 0) {
    return { agent, toolRegistry, onRunEnd };
  }
  const options = subagentOptionsOf(subagents);
  const background = new BackgroundTasks(options.maxConcurrent);
  const sessions = TaskSessions.of(options.sessions, run.sessionId);
  const ctx: TaskContext = { subagents, names: summaries.map((s) => s.name), background, sessions };
  const extended = withPromptTool(agent, toolRegistry, createTaskTool(ctx), subagentsPromptBlock(summaries));
  const tools = { ...extended.agent.tools };
  for (const tool of createBackgroundTools(background)) {
    extended.toolRegistry.register(tool);
    tools[tool.name] = { tool: tool.name };
  }
  return {
    agent: extendAgent(extended.agent, { tools }),
    toolRegistry: extended.toolRegistry,
    onRunEnd: endBackgroundTasks(background, options.awaitBackgroundOnFinish === true, onRunEnd),
  };
}
