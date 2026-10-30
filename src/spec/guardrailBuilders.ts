/**
 * Builds the starter-set guardrails `policy.guardrails` (v1) and
 * `spec.guardrails` (v2) name, from their already-validated options.
 * Internal: not re-exported from the spec index.
 */
import type { z } from 'zod';
import { moderationGuardrail, piiGuardrail, promptInjectionGuardrail, secretsGuardrail } from '../execution/guardrailStarterSet';
import {
  denyTopicsGuardrail,
  llmJudgeGuardrail,
  maxLengthGuardrail,
  regexGuardrail,
  type IoGuardrail,
} from '../execution/ioGuardrails';
import { GUARDRAIL_OPTIONS, type SpecGuardrailName } from './guardrailOptions';

type GuardrailOptions<N extends SpecGuardrailName> = z.infer<(typeof GUARDRAIL_OPTIONS)[N]>;

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_JUDGE_INSTRUCTION = 'Reject anything unsafe, abusive or outside what this agent is meant to do.';

/** How each built-in guardrail name builds its guardrail from its options. */
const BUILDERS: { [N in SpecGuardrailName]: (options: GuardrailOptions<N>) => IoGuardrail } = {
  'max-length': ({ maxChars = DEFAULT_MAX_CHARS }) => maxLengthGuardrail({ maxChars }),
  'secret-scan': (options) => regexGuardrail({ name: 'secret-scan', ...options }),
  regex: ({ pattern, flags, ...options }) => regexGuardrail({ name: 'regex', pattern: new RegExp(pattern, flags), ...options }),
  'deny-topics': ({ topics }) => denyTopicsGuardrail({ topics }),
  'llm-judge': ({ model, instruction = DEFAULT_JUDGE_INSTRUCTION }) => llmJudgeGuardrail({ model, instruction }),
  pii: (options) => piiGuardrail(options),
  secrets: ({ extraPatterns, ...options }) =>
    secretsGuardrail({ ...options, extraPatterns: extraPatterns?.map((pattern) => new RegExp(pattern)) }),
  'prompt-injection': (options) => promptInjectionGuardrail(options),
  moderation: (options) => moderationGuardrail(options),
};

/** Builds the starter-set guardrail `name` from its validated options (without `on`). Moved from policy.ts. */
export function buildSpecGuardrail(name: SpecGuardrailName, options: Record<string, unknown>): IoGuardrail {
  return (BUILDERS[name] as (options: unknown) => IoGuardrail)(options);
}
