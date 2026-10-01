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
import { runSubagent, type SubagentSpec } from '../execution/delegation';
import { subagentBudget } from '../execution/subagentRuntime';
import { isPropagatingToolError } from '../execution/propagatingToolError';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { SubagentCatalog, SubagentSummary, Subagents } from './types';

/** Name of the tool the lead model delegates with. */
const TASK_TOOL = 'task';

/** Same default as `ExecuteOptions.maxSteps`. */
const DEFAULT_MAX_STEPS = 10;

/** An agent usable as a sub-agent: its run configuration and description. */
interface RegisteredSubagent {
  spec: SubagentSpec;
  description?: string;
}

const registeredSubagents = new WeakMap<object, RegisteredSubagent>();

/** Makes `agent` (a `createAgent()` result) usable as a sub-agent. */
export function registerSubagent(agent: object, registration: RegisteredSubagent): void {
  registeredSubagents.set(agent, registration);
}

function isCatalog(subagents: Subagents): subagents is SubagentCatalog {
  const candidate = subagents as Partial<SubagentCatalog>;
  return typeof candidate.list === 'function' && typeof candidate.resolve === 'function';
}

function registrationOf(agent: unknown, name: string, caller: string): RegisteredSubagent {
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

async function listSubagents(subagents: Subagents): Promise<SubagentSummary[]> {
  if (isCatalog(subagents)) {
    const summaries = [...(await subagents.list())];
    assertSummaries(summaries);
    return summaries;
  }
  assertSubagents(subagents, 'subagents');
  return Object.entries(subagents).map(([name, agent]) => ({
    name,
    description: registeredSubagents.get(agent)?.description ?? '',
  }));
}

async function resolveSubagent(subagents: Subagents, name: string, names: readonly string[]): Promise<RegisteredSubagent> {
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
    `Delegate a self-contained task to one of these with the \`${TASK_TOOL}\` tool. A sub-agent sees only the prompt you give it, not this conversation, so include everything it needs. Several \`${TASK_TOOL}\` calls in one turn run in parallel.`,
    '',
    ...summaries.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}

/** Why a sub-agent run that did not finish normally failed. */
function failureReason(name: string, result: ExecutionResult, maxSteps: number): string {
  const last = result.text ? ` Its last text: ${result.text}` : '';
  if (result.finishReason === 'aborted') {
    return `Sub-agent '${name}' was aborted before it finished.${last}`;
  }
  if (result.finishReason === 'max-steps' || result.steps >= maxSteps) {
    return `Sub-agent '${name}' used all ${maxSteps} of its steps (maxSteps) without giving a final answer.${last}`;
  }
  return `Sub-agent '${name}' ended with finish reason '${result.finishReason}' without a final answer.${last}`;
}

/** The `task` tool result: the sub-agent's final text plus a metadata footer. Throws when it did not finish. */
function taskResult(name: string, result: ExecutionResult, maxSteps: number): string {
  if (result.finishReason !== 'stop' && result.finishReason !== 'length') {
    throw new Error(failureReason(name, result, maxSteps));
  }
  const footer = `[sub-agent '${name}': ${result.steps} step(s), finish reason '${result.finishReason}']`;
  return result.text ? `${result.text}\n\n${footer}` : footer;
}

async function runTask(
  subagents: Subagents,
  names: readonly string[],
  args: { agent: string; prompt: string; description: string },
  toolOptions: { abortSignal?: AbortSignal } | undefined
): Promise<string> {
  const { spec } = await resolveSubagent(subagents, args.agent, names);
  let result: ExecutionResult;
  try {
    result = await runSubagent(spec, {
      name: args.agent,
      input: [{ role: 'user', content: args.prompt }],
      toolOptions,
      description: args.description,
    });
  } catch (error) {
    if (isPropagatingToolError(error)) throw error;
    throw new Error(`Sub-agent '${args.agent}' failed: ${(error as Error | undefined)?.message ?? String(error)}`);
  }
  return taskResult(args.agent, result, spec.maxSteps ?? DEFAULT_MAX_STEPS);
}

function createTaskTool(subagents: Subagents, summaries: readonly SubagentSummary[]): DefinedTool {
  const names = summaries.map((s) => s.name);
  return defineTool({
    name: TASK_TOOL,
    description:
      'Delegate a self-contained task to a sub-agent listed under "Available sub-agents" and get its final answer back. ' +
      'The sub-agent sees only your prompt, not this conversation.',
    input: z.object({
      agent: z.enum(names as [string, ...string[]]).describe('Name of the sub-agent, exactly as listed'),
      prompt: z.string().describe('Complete instructions for the sub-agent, including all context it needs'),
      description: z.string().describe('A short (3-5 word) label for this task'),
    }),
    execute: (args, ctx) => runTask(subagents, names, args, ctx),
  });
}

/** Throws when the agent already has a tool named `task`. */
export function assertNoTaskTool(agent: AgentConfig, toolRegistry: ToolRegistry | undefined): void {
  if (toolRegistry?.has(TASK_TOOL) || agent.tools?.[TASK_TOOL]) {
    throw new Error(
      `subagents: a tool named '${TASK_TOOL}' is already registered, but agents with sub-agents get one automatically. ` +
        `Rename your tool, or remove the 'subagents' option.`
    );
  }
}

/**
 * Applies `subagents` to an agent run: adds the `task` tool and the
 * "Available sub-agents" prompt block - unless this run is already at the
 * sub-agent depth limit (see `maxSubagentDepth`), or the catalog is empty.
 * Inputs are not mutated.
 */
export async function withSubagents(
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  subagents: Subagents | undefined,
  maxSubagentDepth: number | undefined
): Promise<{ agent: AgentConfig; toolRegistry: ToolRegistry | undefined }> {
  if (!subagents || subagentBudget(maxSubagentDepth) <= 0) {
    return { agent, toolRegistry };
  }
  assertNoTaskTool(agent, toolRegistry);
  const summaries = await listSubagents(subagents);
  if (summaries.length === 0) {
    return { agent, toolRegistry };
  }
  return withPromptTool(agent, toolRegistry, createTaskTool(subagents, summaries), subagentsPromptBlock(summaries));
}
