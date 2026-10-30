/**
 * The `spec.guardrails` section of AgentSpec v2: each entry names a
 * starter-set guardrail (SPEC_GUARDRAIL_NAMES), carries a stable `id` (the
 * guardrail's trip name and its `guard:<id>` node id), the sides it checks
 * (`on`), `runInParallel`, `onTripped` and the built-in's `options`.
 * Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { anyError } from '../../utils/zodCompat';
import { GUARDRAIL_OPTIONS, SPEC_GUARDRAIL_NAMES, unknownGuardrailMessage, type SpecGuardrailName } from '../guardrailOptions';
import { forwardIssues, refineUniqueIds, specIdSchema } from './common';
import { addUnsupportedIssue } from './unsupported';

/** A side a guardrail checks: the user input, the assistant output, or tool call arguments. */
export type GuardrailSide = 'input' | 'output' | 'tools';

/** One `spec.guardrails` entry. */
export interface GuardrailSpec {
  id: string;
  name: SpecGuardrailName;
  on?: GuardrailSide | GuardrailSide[];
  runInParallel?: boolean;
  onTripped?: 'block' | 'rewrite' | 'warn';
  options?: Record<string, unknown>;
}

/** Built-ins whose options take `action: 'block' | 'rewrite'`. */
export const REWRITABLE_GUARDRAILS: readonly SpecGuardrailName[] = ['secret-scan', 'regex', 'pii', 'secrets'];

/** The sides an entry checks: `on` as a list (default `['input', 'output']`, as v1). */
export function guardrailSidesOf(entry: Pick<GuardrailSpec, 'on'>): GuardrailSide[] {
  const on = entry.on ?? ['input', 'output'];
  return typeof on === 'string' ? [on] : on;
}

/** The action an entry compiles to: `onTripped` wins over `options.action` (a conflict is rule 5). */
function effectiveAction(entry: GuardrailSpec): unknown {
  return entry.onTripped === 'block' || entry.onTripped === 'rewrite' ? entry.onTripped : entry.options?.action;
}

/** Rule 1: `on` inside `options` is a v1 habit; in v2 it belongs on the entry itself. */
function checkOptionsSide(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  if (entry.options !== undefined && 'on' in entry.options) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options', 'on'],
      message: "move 'on' out of options, onto the guardrail itself",
    });
  }
}

/** Rule 2: the named built-in's own options schema (GUARDRAIL_OPTIONS[name]). */
function checkOptionsShape(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  forwardIssues(GUARDRAIL_OPTIONS[entry.name].safeParse(entry.options ?? {}), ctx, ['options']);
}

/** Rule 3: 'warn' has no SDK mechanism; a guardrail can only block or rewrite. */
function checkWarn(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  if (entry.onTripped === 'warn') {
    addUnsupportedIssue(ctx, "onTripped 'warn' (a guardrail can only block or rewrite)", ['onTripped']);
  }
}

/** Rule 4: 'rewrite' only for the built-ins whose options take `action`. */
function checkRewrite(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  if (entry.onTripped === 'rewrite' && !REWRITABLE_GUARDRAILS.includes(entry.name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['onTripped'], message: `'${entry.name}' cannot rewrite; use 'block'` });
  }
}

/** Rule 5: `onTripped` and `options.action` say the same thing; setting both differently is a mistake. */
function checkActionConflict(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  if (entry.onTripped !== undefined && entry.options?.action !== undefined && entry.options.action !== entry.onTripped) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options', 'action'],
      message: 'set either onTripped or options.action, not both',
    });
  }
}

/** Rules 6 and 7: `runInParallel` is honoured on input guardrails only, and a parallel check cannot rewrite. */
function checkParallel(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  if (entry.runInParallel !== true) return;
  if (!guardrailSidesOf(entry).includes('input')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runInParallel'], message: 'only input guardrails run in parallel' });
  }
  if (effectiveAction(entry) === 'rewrite') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runInParallel'], message: 'a parallel guardrail cannot rewrite' });
  }
}

/** All the `spec.guardrails` entry rules, run so every problem is reported at once. */
function refineGuardrail(entry: GuardrailSpec, ctx: z.RefinementCtx): void {
  checkOptionsSide(entry, ctx);
  checkOptionsShape(entry, ctx);
  checkWarn(entry, ctx);
  checkRewrite(entry, ctx);
  checkActionConflict(entry, ctx);
  checkParallel(entry, ctx);
}

const guardrailSideSchema = z.enum(['input', 'output', 'tools']);

/** One `spec.guardrails` entry (zod): `id` plus the named built-in's `options`, `on`, `runInParallel`, `onTripped`. */
// fallow-ignore-next-line unused-export -- composed by guardrailListSchema; exported for section schemas that embed it
export const guardrailSpecSchema = z
  .object({
    id: specIdSchema,
    name: z.enum(SPEC_GUARDRAIL_NAMES, anyError((value) => unknownGuardrailMessage(String(value)))),
    on: z.union([guardrailSideSchema, z.array(guardrailSideSchema).min(1)]).optional(),
    runInParallel: z.boolean().optional(),
    onTripped: z.enum(['block', 'rewrite', 'warn']).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine(refineGuardrail);

/** The `spec.guardrails` list (zod): each id must be unique. */
export const guardrailListSchema = z.array(guardrailSpecSchema).superRefine(refineUniqueIds);
