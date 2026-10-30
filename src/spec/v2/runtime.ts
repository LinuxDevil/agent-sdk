/**
 * The plain-data `createAgent` option keys of AgentSpec v2 (`modelSettings`,
 * `reasoning`, `limits`, `retry`, `permissionMode`, `mcpServers`, ...) with
 * the SDK's real option shapes, so `specV2ToAgent` can pass a parsed spec
 * straight to `createAgent()`. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { APPROVAL_TTL_RULE, isApprovalTtl } from '../../execution/permissions';
import { modelSettingProblem } from '../../execution/modelSettings';
import { anyError } from '../../utils/zodCompat';
import { runLimitsSchema } from '../runLimitsSchema';
import { modelIdSchema } from './common';
import { mcpServersSchema } from './mcpServers';

const posInt = z.number().int().positive();
const nonNegInt = z.number().int().min(0);

/** A 0-1 fraction: `(0,1]` for 'gt0' (a threshold that must compact something), `[0,1]` for 'gte0'. */
const fraction = (min: 'gt0' | 'gte0') => (min === 'gt0' ? z.number().gt(0) : z.number().min(0)).max(1);

/** `ModelSettings` as data: only the SDK's keys, each checked by `modelSettingProblem` (so synonyms get a did-you-mean). */
const modelSettingsSchema = z.record(z.string(), z.unknown()).superRefine((settings, ctx) => {
  for (const [key, value] of Object.entries(settings)) {
    const problem = modelSettingProblem(key, value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: [key] });
  }
});

/** `ReasoningOption`: an effort, or `ReasoningSettings` (strict; `search`-style extras are not data). */
const reasoningSchema = z.union(
  [
    z.enum(['none', 'minimal', 'low', 'medium', 'high']),
    z
      .object({
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
        budgetTokens: posInt.optional(),
        summary: z.enum(['auto', 'none']).optional(),
        force: z.boolean().optional(),
      })
      .strict(),
  ],
  anyError("must be 'none', 'minimal', 'low', 'medium', 'high' or { effort, budgetTokens, summary, force }")
);

/** `AgentSpecV2Compaction` as data (AgentCompactionOptions minus `strategy`/`onCompaction`; `summarizer` is a 'provider/model' string). */
const compactionSchema = z.union(
  [
    z.boolean(),
    z
      .object({
        thresholdPercent: fraction('gt0').optional(),
        contextWindow: posInt.optional(),
        protectedTokens: posInt.optional(),
        reserveOutputTokens: posInt.optional(),
        summarizer: modelIdSchema.optional(),
      })
      .strict(),
  ],
  anyError('must be true, false or { thresholdPercent, contextWindow, protectedTokens, reserveOutputTokens, summarizer }')
);

/** `AgentSpecV2Retry` as data (WithRetryOptions minus the function and signal fields). */
const retrySchema = z.union(
  [
    z.literal(false),
    z
      .object({
        maxRetries: nonNegInt.optional(),
        backoff: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.boolean().optional(),
          })
          .strict()
          .optional(),
        timeoutMs: z.number().positive().optional(),
        idleTimeoutMs: z.number().positive().optional(),
      })
      .strict(),
  ],
  anyError('must be false or { maxRetries, backoff, timeoutMs, idleTimeoutMs }')
);

/** `RateLimitOptions`: the three optional rate/concurrency caps. */
const rateLimitSchema = z
  .object({
    requestsPerMinute: posInt.optional(),
    tokensPerMinute: posInt.optional(),
    maxConcurrent: posInt.optional(),
  })
  .strict();

/** `ToolSearchOptions` minus `search` (a function), or `false`. */
const toolSearchSchema = z.union(
  [
    z.literal(false),
    z
      .object({
        thresholdPercent: fraction('gte0').optional(),
        maxResults: posInt.optional(),
        contextWindow: posInt.optional(),
      })
      .strict(),
  ],
  anyError('must be false or { thresholdPercent, maxResults, contextWindow }')
);

/** `boolean | CodeModeOptions`. */
const codeModeSchema = z.union(
  [
    z.boolean(),
    z
      .object({
        tools: z.array(z.string().min(1)).optional(),
        exclusive: z.boolean().optional(),
        timeoutMs: posInt.optional(),
        memoryLimitBytes: posInt.optional(),
        maxToolCalls: posInt.optional(),
        maxOutputChars: posInt.optional(),
      })
      .strict(),
  ],
  anyError('must be true, false or { tools, exclusive, timeoutMs, memoryLimitBytes, maxToolCalls, maxOutputChars }')
);

/** `SubagentOptions` minus `sessions` (a store, not data). */
const subagentOptionsSchema = z
  .object({
    maxConcurrent: posInt.optional(),
    awaitBackgroundOnFinish: z.boolean().optional(),
    background: z.boolean().optional(),
    continuation: z.boolean().optional(),
  })
  .strict();

/** The S01b keys, spread into agentSpecV2Shape. */
export const runtimeShape = {
  modelSettings: modelSettingsSchema.optional(),
  reasoning: reasoningSchema.optional(),
  limits: runLimitsSchema.optional(),
  maxSteps: posInt.optional(),
  compaction: compactionSchema.optional(),
  retry: retrySchema.optional(),
  rateLimit: rateLimitSchema.optional(),
  promptCaching: z.union([z.literal('auto'), z.literal(false)], anyError("must be 'auto' or false")).optional(),
  toolSearch: toolSearchSchema.optional(),
  codeMode: codeModeSchema.optional(),
  permissionMode: z
    .enum(['default', 'plan', 'acceptEdits', 'dontAsk'], anyError("must be 'default', 'plan', 'acceptEdits' or 'dontAsk'"))
    .optional(),
  approvalTtlMs: z.number().refine(isApprovalTtl, `must be ${APPROVAL_TTL_RULE}`).optional(),
  askQuestion: z.boolean().optional(),
  mcpServers: mcpServersSchema.optional(),
  subagentOptions: subagentOptionsSchema.optional(),
  maxSubagentDepth: nonNegInt.optional(),
  maxHandoffs: nonNegInt.optional(),
};
