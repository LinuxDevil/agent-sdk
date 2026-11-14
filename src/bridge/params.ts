/**
 * Per-method `params` validation for the bridge (W10a): one strict zod
 * object per {@link BridgeMethod}. `spec` stays `z.unknown()` here —
 * `parseAgentSpecV2` owns spec validation and reports the richer errors.
 * A failure throws {@link BridgeError} `LOUSHO_BRIDGE_BAD_PARAMS` whose
 * `details` are the issues reduced to `{ path, message }`.
 */
import { z } from 'zod';
import { issueMessage, issuePath } from '../utils/zodCompat';
import { BridgeError } from './bridgeError';
import type { BridgeMethod, BridgeParams } from './protocol';

/** `agentId`: the protocol's shape rule — no leading punctuation, no `..`. */
const agentId = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/, 'agentId must start alphanumeric and use only letters, digits, dot, dash and underscore')
  .refine((id) => !id.includes('..'), 'agentId must not contain ".."');

/** `env` keys are provider-key names only: `OPENAI_API_KEY`-shaped. */
const envKey = z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, 'env keys must look like OPENAI_API_KEY');

const secrets = z.record(z.string(), z.string());
const env = z.record(envKey, z.string());

/** The fields `run`, `chat` and `compile` share (compile drops sessionId/captureContent). */
const runBase = {
  agentId,
  spec: z.unknown(),
  secrets: secrets.optional(),
  env: env.optional(),
};

const PARAM_SCHEMAS = {
  hello: z
    .object({
      protocol: z.number().int(),
      client: z.object({ name: z.string().min(1), version: z.string() }).strict(),
    })
    .strict(),
  compile: z.object({ ...runBase }).strict(),
  run: z.object({ ...runBase, sessionId: z.string(), captureContent: z.boolean().optional(), input: z.string() }).strict(),
  chat: z
    .object({ ...runBase, sessionId: z.string(), captureContent: z.boolean().optional(), messages: z.array(z.unknown()) })
    .strict(),
  steer: z.object({ runId: z.string(), message: z.string().min(1).max(3000) }).strict(),
  abort: z.object({ runId: z.string(), reason: z.string().min(1).max(200).optional() }).strict(),
  resolveApproval: z
    .object({ runId: z.string(), approvalId: z.string(), approved: z.boolean(), note: z.string().optional() })
    .strict(),
  answerQuestion: z
    .object({ runId: z.string(), questionId: z.string(), answer: z.string().min(1).max(4000) })
    .strict(),
  catalog: z.object({}).strict(),
  shutdown: z.object({}).strict(),
} satisfies Record<BridgeMethod, z.ZodTypeAny>;

/**
 * Validates `params` for `method` (`undefined` reads as `{}`). Returns the
 * parsed value typed as the method's {@link BridgeParams} entry; throws
 * `LOUSHO_BRIDGE_BAD_PARAMS` with path+message `details` on failure.
 */
export function parseParams<M extends BridgeMethod>(method: M, params: unknown): BridgeParams[M] {
  const result = PARAM_SCHEMAS[method].safeParse(params ?? {});
  if (result.success) return result.data as BridgeParams[M];
  const issues = result.error.issues.map((issue) => ({ path: issuePath(issue), message: issueMessage(issue) }));
  const first = issues[0];
  const where = first.path === '(root)' ? first.message : `${first.path}: ${first.message}`;
  throw new BridgeError('LOUSHO_BRIDGE_BAD_PARAMS', `Invalid params for '${method}': ${where}`, issues);
}
