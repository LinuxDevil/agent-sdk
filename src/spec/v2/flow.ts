/**
 * The `flow` key of AgentSpec v2: an AgentFlow the run follows instead of a
 * plain agent loop. flowSpecSchema is the zod half (an AgentFlow-shaped
 * object); flowProblems() is the semantic half — every step must be a shape
 * FlowExecutor can run and must carry an explicit id, so the builder never
 * stores a flow that fails at run time. Browser-safe: zod and the pure
 * flows/validators only — no `node:` imports and never FlowExecutor.ts,
 * which pulls the provider stack into the bundle.
 */
import { z } from 'zod';
import { validateFlow } from '../../flows/validators';
import type { AgentFlow } from '../../types/flow';

/** One step-path segment or a whole path, relative to the spec root. */
type StepPath = (string | number)[];

/**
 * A validation problem of a spec's `flow`. `path` is relative to the spec
 * root (e.g. `['flow', 'flow', 'steps', 2, 'agent']`); Studio's canvas maps
 * problems to node badges by the step id they sit on.
 */
export interface FlowProblem {
  path: StepPath;
  message: string;
  /** true → parseAgentSpecV2 reports LOUSHO_SPEC_UNSUPPORTED; false → LOUSHO_SPEC_INVALID. */
  unsupported: boolean;
}

/**
 * The step `type`s FlowExecutor runs — a copy of its `handlersByType` keys,
 * kept here because importing FlowExecutor.ts would pull providers into
 * browser bundles. The parity test in flow.test.ts keeps the two lists equal.
 */
export const EXECUTABLE_TYPES = [
  'sequence',
  'parallel',
  'oneOf',
  'forEach',
  'evaluator',
  'llmCall',
  'agent',
  'approval',
  'toolCall',
  'setVariable',
  'return',
  'end',
  'throw',
] as const;

type ExecutableType = (typeof EXECUTABLE_TYPES)[number];

const EXECUTABLE_SET: ReadonlySet<string> = new Set(EXECUTABLE_TYPES);

/**
 * Step `type`s that exist only in the editor union (EditorShapeStep): the
 * executor throws LOUSHO_FLOW_INVALID when it reaches one, so the spec
 * refuses them instead. `oneOf`/`forEach`/`evaluator` are executable but
 * have editor variants too — those are detected by their fields inside
 * STEP_RULES.
 */
const EDITOR_ONLY_TYPES: ReadonlySet<string> = new Set(['step', 'bestOfAll', 'tool', 'uiComponent', 'condition', 'loop']);

/** Walk state: the problems collected so far, the known subagent names, and the step ids already seen. */
interface Walk {
  problems: FlowProblem[];
  agentNames: ReadonlySet<string>;
  seenIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function report(ctx: Walk, path: StepPath, message: string, unsupported = false): void {
  ctx.problems.push({ path, message, unsupported });
}

/**
 * Every step needs an explicit non-empty `id` — spans and checkpoints map
 * back to canvas nodes by it. A repeat is flagged once at its own path.
 */
function checkId(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  const id = step.id;
  if (typeof id !== 'string' || id === '') {
    report(ctx, [...path, 'id'], 'every flow step needs an id');
  } else if (ctx.seenIds.has(id)) {
    report(ctx, [...path, 'id'], `duplicate step id '${id}'`);
  } else {
    ctx.seenIds.add(id);
  }
}

/** `<path>.<field>: required` — the field must be a non-empty string. */
function requireField(step: Record<string, unknown>, path: StepPath, ctx: Walk, field: string): void {
  const value = step[field];
  if (typeof value !== 'string' || value === '') report(ctx, [...path, field], 'required');
}

/** `sequence`/`parallel`: a non-empty `steps`, each child walked in place. */
function containerStep(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  const steps = step.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    report(ctx, [...path, 'steps'], 'needs at least one step');
    return;
  }
  steps.forEach((child, index) => walk(child, [...path, 'steps', index], ctx));
}

/** `oneOf`: `{ branches }` is the editor shape; `{ options: [{ step }] }` is the one that runs. */
function oneOfStep(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  if ('branches' in step) {
    report(ctx, path, "this 'oneOf' shape is editor-only; use 'options'", true);
    return;
  }
  const options = step.options;
  if (!Array.isArray(options) || options.length === 0) {
    report(ctx, [...path, 'options'], 'needs at least one option');
    return;
  }
  options.forEach((option, index) => {
    const stepPath = [...path, 'options', index, 'step'];
    if (!isRecord(option) || option.step === undefined) report(ctx, stepPath, 'required');
    else walk(option.step, stepPath, ctx);
  });
}

/** `forEach`: `{ item, inputFlow }` is the editor shape; `{ items, step? }` is the one that runs. */
function forEachStep(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  if ('inputFlow' in step || 'item' in step) {
    report(ctx, path, "this 'forEach' shape is editor-only; use 'items' and 'step'", true);
    return;
  }
  const items = step.items;
  if (!Array.isArray(items) && !(typeof items === 'string' && items.startsWith('$'))) {
    report(ctx, [...path, 'items'], "a list or a '$variable'");
  }
  if (step.step !== undefined) walk(step.step, [...path, 'step'], ctx);
}

/** `evaluator`: `{ criteria, subFlow }` is the editor shape; `{ expression }` is the one that runs. */
function evaluatorStep(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  if ('criteria' in step || 'subFlow' in step) {
    report(ctx, path, "this 'evaluator' shape is editor-only; use 'expression'", true);
    return;
  }
  requireField(step, path, ctx, 'expression');
}

/** `agent`: the name must be 'self' (the spec's own agent) or a key of `subagents`. */
function agentStep(step: Record<string, unknown>, path: StepPath, ctx: Walk): void {
  const agent = step.agent;
  if (typeof agent !== 'string' || agent === '') {
    report(ctx, [...path, 'agent'], 'required');
  } else if (agent !== 'self' && !ctx.agentNames.has(agent)) {
    report(ctx, [...path, 'agent'], `no subagent '${agent}' (use 'self' or a key of subagents)`);
  }
}

/** The rule-checker signature: pushes problems and recurses into children under `path`. */
type StepChecker = (step: Record<string, unknown>, path: StepPath, ctx: Walk) => void;

/** A leaf step with no rules of its own (return / end / throw). */
const leafStep: StepChecker = () => {};

/** One checker per executable step type. */
const STEP_RULES: Record<ExecutableType, StepChecker> = {
  sequence: containerStep,
  parallel: containerStep,
  oneOf: oneOfStep,
  forEach: forEachStep,
  evaluator: evaluatorStep,
  llmCall: (step, path, ctx) => requireField(step, path, ctx, 'prompt'),
  agent: agentStep,
  approval: (step, path, ctx) => requireField(step, path, ctx, 'message'),
  toolCall: (step, path, ctx) => requireField(step, path, ctx, 'tool'),
  setVariable: (step, path, ctx) => requireField(step, path, ctx, 'variable'),
  return: leafStep,
  end: leafStep,
  throw: leafStep,
};

/**
 * Walks one step at `path`: flags editor-only types (unsupported), unknown
 * types and the type's own rules, then checks the id every node must carry.
 */
function walk(step: unknown, path: StepPath, ctx: Walk): void {
  if (!isRecord(step)) {
    report(ctx, path, 'a flow step is an object with a type and an id');
    return;
  }
  const type = step.type;
  if (typeof type === 'string' && EDITOR_ONLY_TYPES.has(type)) {
    report(ctx, path, `'${type}' steps are an editor shape the flow runner cannot run`, true);
  } else if (typeof type === 'string' && EXECUTABLE_SET.has(type)) {
    STEP_RULES[type as ExecutableType](step, path, ctx);
  } else {
    report(ctx, path, `unknown step type '${String(type)}'`);
  }
  checkId(step, path, ctx);
}

/**
 * Everything wrong with `flow` for a spec whose subagent names are
 * `agentNames`; empty when the flow can run. Shared by the zod schema (the
 * spec-level superRefine in schema.ts) and the canvas (C15/C19 map problems
 * to node badges by step id).
 */
export function flowProblems(flow: unknown, ctx: { agentNames: readonly string[] }): FlowProblem[] {
  const walkCtx: Walk = { problems: [], agentNames: new Set(ctx.agentNames), seenIds: new Set() };
  const object: Partial<AgentFlow> = isRecord(flow) ? (flow as Partial<AgentFlow>) : {};
  for (const error of validateFlow(object).errors) report(walkCtx, ['flow'], error);
  if (object.flow === undefined || object.flow === null) {
    report(walkCtx, ['flow', 'flow'], 'the flow needs a first step');
  } else {
    walk(object.flow, ['flow', 'flow'], walkCtx);
  }
  return walkCtx.problems;
}

/**
 * zod schema of the `flow` key: an AgentFlow-shaped object (extra keys are
 * rejected). The step rules live in the spec-level superRefine instead —
 * they need the spec's `subagents` keys, which a field schema cannot see.
 */
export const flowSpecSchema: z.ZodType<AgentFlow> = z
  .object({
    code: z.string(),
    name: z.string(),
    description: z.string().optional(),
    inputs: z.array(z.unknown()).optional(),
    flow: z.unknown(),
    agents: z.array(z.unknown()).optional(),
    id: z.string().optional(),
  })
  .strict() as unknown as z.ZodType<AgentFlow>;
