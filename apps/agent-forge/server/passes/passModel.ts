/**
 * `callPassModel` - the one way a background pass talks to a model (L06b).
 *
 * Every pass (version summaries, draft reviews, portability checks,
 * prompt suggestions, auto approvals, eval judges) asks for a JSON
 * object, gets it back through the provider resolved exactly like the
 * judge/playground resolve it (stored keys before env vars), has the
 * reply validated against its own zod schema, and has its usage and
 * cost recorded on the pass's `PassContext` - an unusable reply was
 * still billed, so `ctx.record` runs before parsing.
 *
 * Failures map onto the PassRunner's settle-without-retry classes:
 * a disabled kind or a missing provider key is `PassSkippedError`/
 * `PassUnavailableError`, a provider refusal is `PassRefusedError`,
 * and prose-without-JSON or a schema mismatch is `PassOutputError`
 * (retried, then `failed`/`invalid_output`).
 *
 * Prompts and replies are never logged - they hold user instructions.
 */
import { estimateCost, SDKError } from 'lousho';
import type { LLMProvider } from 'lousho';
import { z } from 'zod';
import type { PassKind } from '../../shared/wireTypes';
import { buildAgentFromSpec } from '../buildAgent';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import { providerOf } from '../playground';
import { firstJsonObject } from './jsonReply';
import {
  PassOutputError,
  PassRefusedError,
  PassSkippedError,
  PassUnavailableError,
  type PassContext,
} from './passRunner';

export interface PassModelInput<T> {
  kind: PassKind;
  system: string;
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** `provider/model`; default `settings.passes().model`. */
  model?: string;
  timeoutMs: number;
  ctx: PassContext;
  secretsStore: SecretsStore;
  settings: SettingsStore;
  /** Output cap; default 1024. */
  maxOutputTokens?: number;
}

/** `provider/model` → the provider, resolved like the judge's (stored keys first). */
function resolvePassProvider(model: string, secretsStore: SecretsStore): LLMProvider {
  try {
    const spec = { name: 'pass', prompt: '', provider: providerOf(model) };
    return buildAgentFromSpec(spec, 'pass', undefined, { secretsStore }).provider;
  } catch (error) {
    const code = error instanceof SDKError ? error.code : undefined;
    if (code === 'LOUSHO_PROVIDER_MISSING_API_KEY') throw new PassUnavailableError((error as Error).message);
    throw error;
  }
}

/** The reply's usage as a `PassRecord` partial: tokens normalized, cost provider-reported or registry-estimated. */
function usageOf(reply: { usage?: { promptTokens: number; completionTokens: number; costUsd?: number } }, model: string) {
  const usage = reply.usage;
  if (usage === undefined) return {};
  const inputTokens = usage.promptTokens;
  const outputTokens = usage.completionTokens;
  const costUsd = usage.costUsd ?? estimateCost({ inputTokens, outputTokens }, model) ?? null;
  return {
    usage: { inputTokens, outputTokens },
    costUsd,
  };
}

/** The reply text as the schema's `T`, or the `PassOutputError`/`PassRefusedError` it earns. */
function parseReply<T>(text: string, finishReason: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  if (finishReason === 'content_filter') throw new PassRefusedError('The model declined this request.');
  const object = firstJsonObject(text);
  if (object === undefined) throw new PassOutputError('The model did not return a JSON object.');
  const parsed = schema.safeParse(object);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.map(String).join('.');
    throw new PassOutputError(`${path === '' ? '(root)' : path}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * Runs one pass model call and returns the schema-validated reply.
 * Throws the PassRunner's error classes for every non-answer outcome.
 */
export async function callPassModel<T>(input: PassModelInput<T>): Promise<T> {
  if (input.settings.passes().enabled[input.kind] === false) {
    throw new PassSkippedError('Turned off in settings');
  }
  const model = input.model ?? input.settings.passes().model;
  const provider = resolvePassProvider(model, input.secretsStore);
  input.ctx.record({ model });

  const signal = AbortSignal.any([input.ctx.signal, AbortSignal.timeout(input.timeoutMs)]);
  const reply = await provider.generate({
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.prompt },
    ],
    temperature: 0,
    maxTokens: input.maxOutputTokens ?? 1024,
    signal,
  });

  // An unusable reply was still billed: record usage/cost before parsing.
  const { usage, costUsd } = usageOf(reply, model);
  if (usage !== undefined) input.ctx.record({ usage, costUsd });

  return parseReply(reply.text, reply.finishReason, input.schema);
}
