/**
 * The `spec.evals` section of AgentSpec v2: publish gates over observe
 * datasets (PLAN §3.1 Contract A, X01a). Each entry names a dataset and the
 * gates every example run must pass for the pass rate to count; the Studio
 * publish gate (X01b) runs them before a version is pinned. The schema
 * validates the data only - running the gates is the eval gate runner's
 * job (`apps/agent-forge/server/evals/`). Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { typeErrors } from '../../utils/zodCompat';
import { forwardIssues, modelIdSchema } from './common';

/** The model-graded gate: `judge` config a pass must reach on the rubric. */
export interface EvalJudgeGate {
  /** 'provider/model' the judge call uses. */
  model: string;
  /** What a good answer looks like; sent to the judge verbatim. */
  rubric: string;
  /** The judge score (0..1) an example needs to pass this gate. */
  minScore: number;
}

/**
 * One gate of an eval spec entry: a single-key object. `calledTool` /
 * `notCalledTool` check the run's tool calls, `maxCostUsd` / `maxSteps`
 * bound the run's cost and length, `judge` asks a model to grade the
 * answer against a rubric.
 */
export type EvalGate =
  | { calledTool: string }
  | { notCalledTool: string }
  | { maxCostUsd: number }
  | { maxSteps: number }
  | { judge: EvalJudgeGate };

/**
 * One `spec.evals` entry: the observe dataset every example comes from, the
 * gates each example run must pass, and the fraction of examples that must
 * pass for the set to count (`minPassRate`, 0..1).
 */
export interface EvalGateSpec {
  /** Observe dataset name. */
  dataset: string;
  /** Gates every example run is checked against. */
  gates: EvalGate[];
  /** Fraction of examples that must pass, 0..1. */
  minPassRate: number;
}

const nonEmptyString = z.string(typeErrors({ required: 'is required', invalid: 'must be a string' })).min(1, 'must not be empty');

const calledToolGate = z.object({ calledTool: nonEmptyString }).strict();
const notCalledToolGate = z.object({ notCalledTool: nonEmptyString }).strict();
const maxCostUsdGate = z.object({ maxCostUsd: z.number().positive('must be greater than 0') }).strict();
const maxStepsGate = z.object({ maxSteps: z.number().int('must be a whole number').positive('must be greater than 0') }).strict();
const judgeGate = z
  .object({
    judge: z
      .object({
        model: modelIdSchema,
        rubric: nonEmptyString.max(8000, 'must be at most 8000 characters'),
        minScore: z.number().min(0, 'must be at least 0').max(1, 'must be at most 1'),
      })
      .strict(),
  })
  .strict();

/** The gate keys, in {@link EvalGate} union order; exactly one may appear per gate object. */
const GATE_KEYS = ['calledTool', 'notCalledTool', 'maxCostUsd', 'maxSteps', 'judge'] as const;
type EvalGateKey = (typeof GATE_KEYS)[number];

const GATE_VARIANTS: Record<EvalGateKey, z.ZodTypeAny> = {
  calledTool: calledToolGate,
  notCalledTool: notCalledToolGate,
  maxCostUsd: maxCostUsdGate,
  maxSteps: maxStepsGate,
  judge: judgeGate,
};

/**
 * Rule 1 of a gate object: it is a plain object carrying exactly one
 * {@link GATE_KEYS} key; returns that key or adds the issue. Rule 2: the
 * key's own strict variant; its issues are forwarded at their own paths
 * (same shape as tools.ts's `kindOf`/`variantOk`, for the same reason - a
 * union's generic failure would not say which field was wrong).
 */
function checkGate(value: unknown, ctx: z.RefinementCtx): void {
  const present =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? GATE_KEYS.filter((key) => key in value)
      : [];
  if (present.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must have exactly one of ${GATE_KEYS.join(', ')}` });
    return;
  }
  forwardIssues(GATE_VARIANTS[present[0]].safeParse(value), ctx);
}

/**
 * One eval gate (zod): validated as data by {@link checkGate} and typed as
 * {@link EvalGate} - the variant checks guarantee the union member.
 */
export const evalGateSchema = z
  .record(z.string(), z.unknown())
  .superRefine(checkGate) as unknown as z.ZodType<EvalGate>;

/** The `gates` list of one eval spec entry: at least one gate. */
const evalGateListSchema = z.array(evalGateSchema).min(1, 'must have at least one gate').max(20, 'must have at most 20 gates');

/**
 * One `spec.evals` entry (zod): a strict object so typos surface, with the
 * dataset name, its gates and the pass-rate floor.
 */
export const evalGateSpecSchema: z.ZodType<EvalGateSpec> = z
  .object({
    dataset: nonEmptyString.max(200, 'must be at most 200 characters'),
    gates: evalGateListSchema,
    minPassRate: z.number().min(0, 'must be at least 0').max(1, 'must be at most 1'),
  })
  .strict();

/** The `spec.evals` list (zod): at most 20 dataset gates per spec. */
export const evalSpecListSchema: z.ZodType<EvalGateSpec[]> = z
  .array(evalGateSpecSchema)
  .max(20, 'must have at most 20 entries');
