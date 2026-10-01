/**
 * Guardrail entries of `AgentSpec.policy.guardrails` (LOU-X5): the built-in
 * names, each one's options, and the entry's validation.
 */
import { z } from 'zod';
import { closestMatch } from '../utils/closestMatch';

/** The built-in guardrails `policy.guardrails` can name (LOU-X5); see `compilePolicy()`. */
export const SPEC_GUARDRAIL_NAMES = ['max-length', 'secret-scan', 'regex', 'deny-topics', 'llm-judge'] as const;
export type SpecGuardrailName = (typeof SPEC_GUARDRAIL_NAMES)[number];

/** A `policy.guardrails` entry: a built-in's name, or `{ name, ...options }`. `on` picks the checked text (default input and output). */
export type AgentSpecGuardrail = string | { name: string; [option: string]: unknown };

const POLICY = 'AgentSpec validation failed:';

const guardrailTargets = z.enum(['input', 'output', 'tools']);
const guardrailBase = { on: z.union([guardrailTargets, z.array(guardrailTargets).min(1)]).optional() };
const rewriteOptions = { action: z.enum(['block', 'rewrite']).optional(), replacement: z.string().optional() };

function regexCompiles(pattern: string, flags?: string): boolean {
  try {
    return new RegExp(pattern, flags) instanceof RegExp;
  } catch {
    return false;
  }
}

/** The options each built-in guardrail takes (besides `name`); strict, so a misspelled option fails. */
export const GUARDRAIL_OPTIONS = {
  'max-length': z.object({ ...guardrailBase, maxChars: z.number().int().positive().optional() }).strict(),
  'secret-scan': z.object({ ...guardrailBase, ...rewriteOptions }).strict(),
  regex: z
    .object({ ...guardrailBase, ...rewriteOptions, pattern: z.string().min(1), flags: z.string().optional() })
    .strict()
    .refine(({ pattern, flags }) => regexCompiles(pattern, flags), { message: 'pattern is not a valid regular expression' }),
  'deny-topics': z.object({ ...guardrailBase, topics: z.array(z.string().min(1)).min(1) }).strict(),
  'llm-judge': z
    .object({ ...guardrailBase, model: z.string().min(1), instruction: z.string().min(1).optional() })
    .strict(),
} satisfies Record<SpecGuardrailName, z.ZodTypeAny>;

/** "unknown guardrail 'x' (did you mean 'y'?). Available: ..." */
export function unknownGuardrailMessage(name: string): string {
  const suggestion = closestMatch(name, SPEC_GUARDRAIL_NAMES);
  return `unknown guardrail '${name}'${suggestion ? ` (did you mean '${suggestion}'?)` : ''}. Available: ${SPEC_GUARDRAIL_NAMES.join(', ')}`;
}

export function isSpecGuardrailName(name: string): name is SpecGuardrailName {
  return (SPEC_GUARDRAIL_NAMES as readonly string[]).includes(name);
}

/** Splits a guardrail entry into its name and options. */
export function guardrailParts(entry: AgentSpecGuardrail): { name: string; options: Record<string, unknown> } {
  const { name, ...options } = typeof entry === 'string' ? { name: entry } : entry;
  return { name, options };
}

export const guardrailEntrySchema = z
  .union([z.string(), z.object({ name: z.string() }).passthrough()], {
    errorMap: () => ({ message: `${POLICY} each guardrail must be a name or an object with a 'name'` }),
  })
  .superRefine((entry, ctx) => {
    const { name, options } = guardrailParts(entry);
    if (!isSpecGuardrailName(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${POLICY} ${unknownGuardrailMessage(name)}` });
      return;
    }
    const parsed = GUARDRAIL_OPTIONS[name].safeParse(options);
    for (const issue of parsed.success ? [] : parsed.error.issues) {
      const where = issue.path.length > 0 ? ` option '${issue.path.join('.')}'` : '';
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${POLICY} guardrail '${name}'${where}: ${issue.message}` });
    }
  });
