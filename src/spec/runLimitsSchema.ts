/**
 * The `limits` option (`RunLimits`) as a zod schema, shared by the v1 spec
 * (`AgentSpec.policy.limits`) and the AgentSpec v2 schema (`limits`). Kept in
 * its own module so spec/v2 can import it without pulling in all of v1's
 * schema; not re-exported from `src/spec/index.ts` (it is not public API).
 */
import { z } from 'zod';

const posInt = z.number().int().positive();

/** Zod schema of `RunLimits` (`src/execution/budget.ts`): strict, each limit a positive integer (cost a positive number). */
export const runLimitsSchema = z
  .object({
    maxTokens: posInt.optional(),
    maxInputTokens: posInt.optional(),
    maxOutputTokens: posInt.optional(),
    maxCostUsd: z.number().positive().optional(),
    maxDurationMs: posInt.optional(),
    maxSteps: posInt.optional(),
    maxToolErrors: posInt.optional(),
    onExceeded: z.enum(['stop', 'throw']).optional(),
  })
  .strict();
