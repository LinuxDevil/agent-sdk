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
import { BackgroundTasks, subagentOptionsOf, withSubagentOptions, type BackgroundTaskView, type SubagentOptions } from './backgroundTasks';
import { busy, taskNotFound, TaskSessions, type TaskMode, type TaskRecord } from './taskSessions';
import { SDKError } from '../execution/errors';
import { allowInPlanMode, PLAN_MODE_REASON, permissionModeOf } from '../execution/permissions';
import { toolFailure } from '../tools/built-in/toolFailure';
import { fromEventUsage, remoteModelKey, usageSince } from '../execution/runUsage';
import type { RunUsage } from '../models/usage';
import type { AgentEventUsage } from '../execution/agentEvents';
import type { PausedBackgroundTask, SuspendedBackgroundTasks } from '../execution/ApprovalGate';

/** Name of the tool the lead model delegates with. */
const TASK_TOOL = 'task';
/** Tools that observe and steer background tasks (LOU-Y4), registered with `task`. */
const BACKGROUND_TOOLS = ['agent_status', 'agent_await', 'agent_cancel'] as const;
/** Told to the model by `task` and `agent_status` (M4). */
const AWAIT_APPROVAL_HINT = 'A task awaiting approval continues only when you call agent_await on it.';

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
    throw new SDKError(
      `${caller}: sub-agent '${name}' is not an agent created with createAgent(). ` +
        `Example: subagents: { ${name}: createAgent({ instructions, description, provider }) }`,
      'LOUSHO_CONFIG_INVALID'
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
  throw new SDKError(
    `${caller}: 'maxSubagentDepth' must be a whole number >= 0, got ${String(value)}. ` +
      'Use 1 (the default) to let only the lead agent delegate, 2 to let its sub-agents delegate too.',
    'LOUSHO_CONFIG_INVALID'
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
      throw new SDKError(
        `${caller}: sub-agent '${name}' has no description. The lead model picks a sub-agent by its description - ` +
          `add one: createAgent({ ..., description: 'Finds and summarizes sources' }).`,
        'LOUSHO_CONFIG_INVALID'
      );
    }
  }
}

function assertSummaries(summaries: readonly SubagentSummary[]): void {
  const seen = new Set<string>();
  for (const { name, description } of summaries) {
    if (!name || seen.has(name)) {
      throw new SDKError(`subagents: catalog list() returned ${name ? `the name '${name}' twice` : 'an empty name'}. Names must be unique and non-empty.`, 'LOUSHO_CONFIG_INVALID');
    }
    if (!description?.trim()) {
      throw new SDKError(`subagents: catalog list() returned sub-agent '${name}' without a description. Add one so the lead model can pick it.`, 'LOUSHO_CONFIG_INVALID');
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
    throw toolFailure(`Unknown sub-agent '${name}'. Valid sub-agents: ${names.join(', ')}.`);
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
    throw toolFailure(failureReason(name, result, maxSteps));
  }
  const footer = `[sub-agent '${name}': ${result.steps} step(s), finish reason '${result.finishReason}', taskId '${taskId}']`;
  const body = result.object === undefined ? result.text : JSON.stringify(result.object);
  return body ? `${body}\n\n${footer}` : footer;
}

type TaskArgs = { agent: string; prompt: string; description: string; background?: boolean; taskId?: string; mode?: TaskMode };
type ToolOptions = { abortSignal?: AbortSignal; onDelegatedUsage?: (usage: RunUsage) => void } | undefined;

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
    throw toolFailure(`Sub-agent '${args.agent}' failed: ${(error as Error | undefined)?.message ?? String(error)}`);
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
  // N4: a deployed sub-agent runs under its own server's permissions, so it cannot be held to the lead's mode.
  const mode = scope ? permissionModeOf(scope.runtime) : 'default';
  if (mode === 'plan') throw toolFailure(`${PLAN_MODE_REASON} The sub-agent '${args.agent}' is deployed elsewhere and does not inherit plan mode.`);
  const paused = scope?.resume && { snapshot: scope.resume.suspension.snapshot, decision: scope.resume.decision };
  const sessionId = paused?.snapshot.sessionId ?? task.remoteSessionId ?? newId('task');
  await task.save({ messages: [], remoteSessionId: sessionId });
  const decision = paused && { approvalId: paused.snapshot.pendingToolCall.id, approved: paused.decision.approved, note: paused.decision.note };
  // N4: in dontAsk mode nothing pauses: a remote approval fails the task instead.
  const pausable = scope?.runtime.approvalStore !== undefined && mode !== 'dontAsk';
  // M10b: the remote run's usage rolls into the lead's totals, like a local child's (LOU-V5). A continuation reports
  // the remote run's usage from its start: only what it spent since the pause (kept on the pause snapshot) is added.
  const reportUsage = scope?.onDelegatedUsage ?? toolOptions?.onDelegatedUsage;
  let reported: RunUsage | undefined;
  const onUsage = (usage: AgentEventUsage) => {
    reported = fromEventUsage(usage, remoteModelKey(args.agent));
    reportUsage?.(usageSince(reported, paused ? paused.snapshot.usage : undefined));
  };
  try {
    return await remote.run(args.prompt, { name: args.agent, signal: toolOptions?.abortSignal, sessionId, taskId: task.taskId, pausable, decision, onUsage });
  } catch (error) {
    if (error instanceof SubagentApprovalPause) {
      error.resumeArgs = { taskId: task.taskId };
      error.snapshot.usage = reported;
    }
    throw error;
  }
}

/** What the `task` tool of one run works with. */
interface TaskContext {
  subagents: Subagents;
  names: readonly string[];
  background: BackgroundTasks;
  sessions: TaskSessions;
  /** M4: the `task` call of each background task, so a paused one can be resumed from the lead's suspension. */
  backgroundCalls: Map<string, TaskArgs>;
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
  if (record.remoteSessionId) throw toolFailure(`Task '${args.taskId}' ran on a remote agent, whose session cannot be copied: use mode 'resume' or 'new'.`);
  return child(await ctx.sessions.allocate(), record);
}

/** Runs (or, inside a resume, resumes) the child of a `task` call with `toolOptions`. */
function runChild(ctx: TaskContext, resolved: ResolvedSubagent, args: TaskArgs, toolOptions: ToolOptions, task: ChildTask): Promise<string> {
  return ctx.sessions.run(task.taskId, () =>
    'remote' in resolved ? runRemoteTask(resolved.remote, args, toolOptions, task) : runTask(resolved.spec, args, toolOptions, task)
  );
}

async function startTask(ctx: TaskContext, args: TaskArgs, toolOptions: ToolOptions): Promise<unknown> {
  const resolved = await resolveSubagent(ctx.subagents, args.agent, ctx.names);
  const task = await openTask(ctx, args, toolCallScopeOf(toolOptions)?.resume !== undefined);
  const run = (options: ToolOptions) => runChild(ctx, resolved, args, options, task);
  if (!args.background) {
    return run(toolOptions);
  }
  ctx.backgroundCalls.set(task.taskId, { agent: args.agent, prompt: args.prompt, description: args.description });
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
  // N4: usable in plan mode because a local sub-agent inherits the mode (a remote one is refused, see runRemoteTask).
  return allowInPlanMode(defineTool({
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
        .describe(`true: start the sub-agent and return a taskId at once; collect the answer later with agent_await. ${AWAIT_APPROVAL_HINT}`),
      taskId: z.string().optional().describe('The taskId of an earlier task of the same agent, to continue (or fork) it'),
      mode: z
        .enum(['new', 'resume', 'fork'])
        .optional()
        .describe("'new' (default without taskId): a fresh sub-agent. 'resume' (default with taskId): continue that task. 'fork': a new task starting from a copy of it"),
    }),
    execute: (args, options) => startTask(ctx, args, options),
  }));
}

type AwaitArgs = { taskId?: string; taskIds?: string[]; timeoutMs?: number };

/** What `agent_await` returns: the one task's view, or `{ tasks }` when it was called with `taskIds`. */
function awaitResult(args: AwaitArgs, views: BackgroundTaskView[]): unknown {
  return args.taskIds ? { tasks: views } : views[0];
}

/**
 * M4: `pause` (of background task `taskId`) as the pause of the lead's `agent_await` call. The re-entered
 * call gets `views` (what it returns once the task is decided) in its args; the `task` call and the other
 * paused tasks, each with its paused run, stay on the suspension record (`suspended`).
 */
function pauseOnTask(pause: SubagentApprovalPause, taskId: string, suspended: SuspendedBackgroundTasks, views: BackgroundTaskView[]): SubagentApprovalPause {
  pause.resumeArgs = { pausedTaskId: taskId, views };
  pause.background = suspended;
  return pause;
}

/** M4: the pause of the lead on the first of `paused` (the rest wait on the suspension), or none. */
function pauseOnFirst([first, ...waiting]: readonly PausedBackgroundTask[], views: BackgroundTaskView[]): SubagentApprovalPause | undefined {
  if (!first) return undefined;
  return pauseOnTask(new SubagentApprovalPause(String(first.task.agent), first.snapshot), first.taskId, { task: first.task, waiting }, views);
}

/** Waits for background tasks; pauses the lead on the first one paused for approval (M4). */
async function awaitTasks(ctx: TaskContext, args: AwaitArgs, signal: AbortSignal | undefined): Promise<unknown> {
  const ids = args.taskIds ?? (args.taskId === undefined ? [] : [args.taskId]);
  if (ids.length === 0) throw toolFailure('agent_await: pass taskId or taskIds.');
  const views = await ctx.background.wait(ids, args.timeoutMs, signal);
  const paused = new Map<string, PausedBackgroundTask>();
  for (const { taskId } of views) {
    const pause = ctx.background.pauseOf(taskId);
    const task = ctx.backgroundCalls.get(taskId);
    if (pause && task) paused.set(taskId, { taskId, task, snapshot: pause.snapshot });
  }
  const pause = pauseOnFirst([...paused.values()], views);
  if (pause) throw pause;
  return awaitResult(args, views);
}

/**
 * M4: `agent_await` re-entered on resume. The paused task is resumed from the suspension (not from the
 * run's background tasks, which ended with the paused run) with the decision, in this call: its answer
 * replaces its view, then the call pauses on the next awaited task still paused, if any.
 */
async function resumeAwaited(ctx: TaskContext, args: AwaitArgs & Record<string, unknown>, toolOptions: ToolOptions, suspended: SuspendedBackgroundTasks): Promise<unknown> {
  const taskId = String(args.pausedTaskId);
  const views = (args.views ?? []) as BackgroundTaskView[];
  const task = suspended.task as TaskArgs;
  let outcome: Pick<BackgroundTaskView, 'status' | 'result' | 'error'>;
  try {
    const resolved = await resolveSubagent(ctx.subagents, task.agent, ctx.names);
    const child: ChildTask = { taskId, history: [], save: (record) => ctx.sessions.save(taskId, task.agent, record) };
    outcome = { status: 'done', result: await runChild(ctx, resolved, task, toolOptions, child) };
  } catch (error) {
    // Paused again: the lead pauses again on the same task (the next approval).
    if (error instanceof SubagentApprovalPause) throw pauseOnTask(error, taskId, suspended, views);
    if (isPropagatingToolError(error)) throw error;
    outcome = { status: 'failed', error: (error as Error | undefined)?.message ?? String(error) };
  }
  const settled = views.map((view) => (view.taskId === taskId ? { ...view, approvalId: undefined, toolName: undefined, ...outcome } : view));
  const next = pauseOnFirst(suspended.waiting, settled);
  if (next) throw next;
  return awaitResult(args, settled);
}

function createBackgroundTools(ctx: TaskContext): DefinedTool[] {
  const { background } = ctx;
  const taskId = z.string().describe('The taskId returned by task with background: true');
  return [
    defineTool({
      name: 'agent_status',
      // N4: observing background tasks changes nothing, so plan mode can use it.
      annotations: { readOnlyHint: true, destructiveHint: false },
      description: `Status of one background task, or of all of them: queued, running, done, failed, cancelled or awaiting-approval, with elapsedMs. ${AWAIT_APPROVAL_HINT}`,
      input: z.object({ taskId: taskId.optional() }),
      execute: ({ taskId: id }) => ({ tasks: background.status(id) }),
    }),
    defineTool({
      name: 'agent_await',
      annotations: { readOnlyHint: true, destructiveHint: false },
      description: "Waits for background tasks and returns each one's answer (or failure). Tasks still running after timeoutMs report status 'timeout'.",
      input: z.object({
        taskId: taskId.optional(),
        taskIds: z.array(z.string()).optional().describe('Several taskIds to wait for'),
        timeoutMs: z.number().int().positive().optional().describe('Stop waiting after this many milliseconds'),
      }),
      execute: (args, options) => {
        const suspended = toolCallScopeOf(options)?.resume?.suspension.background;
        return suspended ? resumeAwaited(ctx, args, options, suspended) : awaitTasks(ctx, args, options.abortSignal);
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
    throw new SDKError(
      `subagents: a tool named '${taken}' is already registered, but agents with sub-agents get one automatically. ` +
        `Rename your tool, or remove the 'subagents' option.`,
      'LOUSHO_CONFIG_INVALID'
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
  const ctx: TaskContext = { subagents, names: summaries.map((s) => s.name), background, sessions, backgroundCalls: new Map() };
  const extended = withPromptTool(agent, toolRegistry, createTaskTool(ctx), subagentsPromptBlock(summaries));
  const tools = { ...extended.agent.tools };
  for (const tool of createBackgroundTools(ctx)) {
    extended.toolRegistry.register(tool);
    tools[tool.name] = { tool: tool.name };
  }
  return {
    agent: extendAgent(extended.agent, { tools }),
    toolRegistry: extended.toolRegistry,
    onRunEnd: endBackgroundTasks(background, options.awaitBackgroundOnFinish === true, onRunEnd),
  };
}
