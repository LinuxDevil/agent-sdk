/**
 * The AgentSpec v2 zod schema: strict at the top level (unknown keys get a
 * did-you-mean suggestion in parseAgentSpecV2) and placeholder fields for
 * every section that has not landed yet, which reject any value with a
 * "not supported yet" issue. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { safeExpressionVariables, ExpressionError } from '../../flows/safeExpression';
import type { AgentFlow } from '../../types/flow';
import { anyError, typeErrors } from '../../utils/zodCompat';
import type { SpecObjectSchema } from '../schema';
import { abortListenerListSchema } from './abortListeners';
import { modelIdSchema, relativePathSchema } from './common';
import { flowProblems, flowSpecSchema } from './flow';
import { evalSpecListSchema } from './evals';
import { guardrailListSchema } from './guardrails';
import { handoffListSchema } from './handoffs';
import { hookListSchema } from './hooks';
import { memoryListSchema } from './memory';
import { outputSpecSchema } from './output';
import { permissionListSchema } from './permissions';
import { runtimeShape } from './runtime';
import { skillRefListSchema } from './skills';
import { subagentsSchemaOf, TOP_LEVEL_ONLY_KEYS } from './subagents';
import { toolRefListSchema } from './tools';
import { triggerListSchema } from './triggers';
import { addUnsupportedIssue } from './unsupported';
import type { AgentSpecV2 } from './types';

/** Agent `name`: 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (subagent names)
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** `shape` minus `keys`, for the inline sub-agent schema; called inside the z.lazy callback only. */
function omitKeys(shape: Record<string, z.ZodTypeAny>, keys: readonly string[]): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(Object.entries(shape).filter(([key]) => !keys.includes(key)));
}

/**
 * An inline sub-agent: every agentSpecV2Shape key except the top-level-only ones
 * (version, triggers, flow, evals), with `description` required - the lead model
 * reads it to pick a sub-agent. Lazy so agentSpecV2Shape is read when it exists
 * (never at module load) and so inline agents may nest `subagents` (depth is a
 * run-time limit, `maxSubagentDepth`).
 */
const inlineAgentSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object(omitKeys(agentSpecV2Shape, TOP_LEVEL_ONLY_KEYS))
    .extend({
      description: z
        .string(
          typeErrors({ required: 'is required for a sub-agent (the lead model reads it)', invalid: 'must be a string' })
        )
        .min(1, 'must not be empty')
        .max(1024, 'must be at most 1024 characters'),
    })
    .strict()
);

/** The v2 shape (zod), for schema composition inside src/spec/v2 (S08 inline subagents, S17 JSON Schema). */
export const agentSpecV2Shape = {
  version: z.literal(2, anyError('must be 2 (convert a v1 spec with upgradeSpec())')),
  name: z
    .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
    .regex(AGENT_NAME_PATTERN, 'must be 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit'),
  description: z
    .string(typeErrors({ invalid: 'must be a string' }))
    .min(1, 'must not be empty')
    .max(1024, 'must be at most 1024 characters')
    .optional(),
  model: modelIdSchema,
  fallbackModels: z.array(modelIdSchema).optional(),
  instructions: z.union([z.string(), z.object({ file: relativePathSchema }).strict()], anyError("must be a string or { file: 'instructions.md' }")),
  instructionsByFamily: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'keys must be lowercase model families such as openai'), z.string())
    .optional(),
  promptRef: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+$/, "must be 'name@version' or 'name@label', e.g. 'support@prod'")
    .optional(),
  ...runtimeShape,
  tools: toolRefListSchema.optional(),
  skills: skillRefListSchema.optional(),
  memory: memoryListSchema.optional(),
  subagents: subagentsSchemaOf(inlineAgentSchema).optional(),
  handoffs: handoffListSchema.optional(),
  guardrails: guardrailListSchema.optional(),
  permissions: permissionListSchema.optional(),
  hooks: hookListSchema.optional(),
  output: outputSpecSchema.optional(),
  triggers: triggerListSchema.optional(),
  abortListeners: abortListenerListSchema.optional(),
  flow: flowSpecSchema.optional(),
  evals: evalSpecListSchema.optional(),
};

/**
 * `spec.flow`'s step rules run at the spec level — they need the spec's
 * `subagents` keys, which a field schema cannot see. `unsupported` problems
 * keep the "not supported yet" marker (LOUSHO_SPEC_UNSUPPORTED); the rest are
 * plain custom issues (LOUSHO_SPEC_INVALID). Paths are already spec-rooted.
 */
function refineFlow(spec: { flow?: AgentFlow; subagents?: unknown }, ctx: z.RefinementCtx): void {
  if (spec.flow === undefined) return;
  const { subagents } = spec;
  const agentNames = typeof subagents === 'object' && subagents !== null ? Object.keys(subagents) : [];
  for (const problem of flowProblems(spec.flow, { agentNames })) {
    if (problem.unsupported) addUnsupportedIssue(ctx, problem.message, problem.path);
    else ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message, path: problem.path });
  }
}

/**
 * `spec.abortListeners`' checks the entry schema cannot see (R03a): unique
 * ids, `triggerId` naming a `webhook`/`channel` trigger, and `when`/`match`
 * parsing as safeExpressions. A parse failure is an issue at the field with
 * the error's `position` in `params` so a form can underline it; a missing
 * variable is fine - only syntax and unsupported-construct `ExpressionError`s
 * count, so the check parses with `safeExpressionVariables` rather than
 * evaluating against an empty scope (which would reject every variable).
 */
type AbortListenerEntry = { id: string; triggerId: string; when: string; match: string };
type AbortListenerSpec = { abortListeners?: AbortListenerEntry[]; triggers?: { id: string; type: string }[] };

function abortIssue(ctx: z.RefinementCtx, message: string, path: (string | number)[], params?: { position: number }): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path, ...(params ? { params } : {}) });
}

function checkAbortTrigger(listener: AbortListenerEntry, triggers: Map<string, string>, path: (string | number)[], ctx: z.RefinementCtx): void {
  const triggerType = triggers.get(listener.triggerId);
  if (triggerType === undefined) {
    abortIssue(ctx, `No trigger '${listener.triggerId}' in this agent.`, [...path, 'triggerId']);
  } else if (triggerType !== 'webhook' && triggerType !== 'channel') {
    abortIssue(ctx, `Abort listeners can only watch webhook or channel triggers; '${listener.triggerId}' is a ${triggerType} trigger.`, [...path, 'triggerId']);
  }
}

function checkAbortExpression(listener: AbortListenerEntry, field: 'when' | 'match', path: (string | number)[], ctx: z.RefinementCtx): void {
  try {
    safeExpressionVariables(listener[field]);
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    abortIssue(ctx, `Expression error at ${error.position}: ${error.reason}`, [...path, field], { position: error.position });
  }
}

function checkAbortListener(listener: AbortListenerEntry, index: number, triggers: Map<string, string>, seen: Set<string>, ctx: z.RefinementCtx): void {
  const path: (string | number)[] = ['abortListeners', index];
  if (seen.has(listener.id)) abortIssue(ctx, `Abort listener id '${listener.id}' is used twice.`, [...path, 'id']);
  else seen.add(listener.id);
  checkAbortTrigger(listener, triggers, path, ctx);
  checkAbortExpression(listener, 'when', path, ctx);
  checkAbortExpression(listener, 'match', path, ctx);
}

function checkAbortListeners(spec: AbortListenerSpec, ctx: z.RefinementCtx): void {
  const listeners = spec.abortListeners;
  if (listeners === undefined) return;
  const triggers = new Map((spec.triggers ?? []).map((trigger) => [trigger.id, trigger.type]));
  const seen = new Set<string>();
  listeners.forEach((listener, index) => checkAbortListener(listener, index, triggers, seen, ctx));
}

function refineSpec(
  spec: AbortListenerSpec & { flow?: AgentFlow; subagents?: unknown },
  ctx: z.RefinementCtx
): void {
  refineFlow(spec, ctx);
  checkAbortListeners(spec, ctx);
}

const schema = z.object(agentSpecV2Shape).strict().superRefine(refineSpec);
// `.superRefine` wraps the object in a ZodEffects under zod 3, dropping `.shape`; SpecObjectSchema promises one.
if (!('shape' in schema)) Object.assign(schema, { shape: agentSpecV2Shape });

/** The v2 schema as published: structural, so declarations do not depend on the installed zod major. */
export const agentSpecV2Schema = schema as unknown as SpecObjectSchema<AgentSpecV2>;
