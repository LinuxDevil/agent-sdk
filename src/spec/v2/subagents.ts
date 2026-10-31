/**
 * The `spec.subagents` section of AgentSpec v2: a record of named sub-agents
 * the lead delegates to with the `task` tool. Each entry picks exactly one
 * form - `{ inline }` embeds a spec, `{ ref }` points at a spec file or agent
 * folder under the agent's base directory and `{ remote }` names a deployed
 * agent by URL. The inline schema is passed in by schema.ts (a lazy
 * agentSpecV2Shape minus the top-level-only keys), so this file never
 * imports schema.ts. Browser-safe: zod only.
 */
import { z } from 'zod';
import { forwardIssues, relativePathSchema } from './common';
import { secretRefSchema } from './secrets';

/** What a `spec.subagents` record key (and its `sub:<name>` node id) must look like. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 consumers (S17 JSON Schema export, Studio subagent forms)
export const SUBAGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The keys an inline sub-agent may not set: only the top-level agent has them. */
export const TOP_LEVEL_ONLY_KEYS = ['version', 'triggers', 'flow', 'evals'] as const;

/** The key that selects a SubagentSpec's form; exactly one must be present on each entry. */
const SUBAGENT_FORMS = ['ref', 'inline', 'remote'] as const;

type SubagentForm = (typeof SUBAGENT_FORMS)[number];

/** A `spec.subagents` record key, e.g. `research` in `sub:research`. */
const subagentNameSchema = z
  .string()
  .regex(SUBAGENT_NAME_PATTERN, 'sub-agent names must be 1-64 letters, digits, dashes or underscores');

const refVariant = z.object({ ref: relativePathSchema }).strict();

const remoteVariant = z
  .object({
    remote: z
      .object({
        url: z.string().url(),
        auth: secretRefSchema.optional(),
        description: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** Rule 1: the entry is a plain object with exactly one {@link SUBAGENT_FORMS} key; returns the form or adds the issue. */
function formOf(value: unknown, ctx: z.RefinementCtx): SubagentForm | undefined {
  const forms =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? SUBAGENT_FORMS.filter((form) => form in value)
      : [];
  if (forms.length === 1) return forms[0];
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must have exactly one of ${SUBAGENT_FORMS.join(', ')}` });
  return undefined;
}

/**
 * The `spec.subagents` record schema (zod): each key is a {@link SUBAGENT_NAME_PATTERN}
 * name, each value a `z.any().superRefine` that runs the "exactly one form" check and
 * then the form's own strict schema, so the issues point at the right paths instead of a
 * union's generic failure. `inlineAgent` is the schema of an inline agent, passed in
 * (lazily) by schema.ts so this file does not import schema.ts (no import cycle).
 */
export function subagentsSchemaOf(inlineAgent: z.ZodTypeAny): z.ZodTypeAny {
  const variants: Record<SubagentForm, z.ZodTypeAny> = {
    ref: refVariant,
    inline: z.object({ inline: inlineAgent }).strict(),
    remote: remoteVariant,
  };
  const entry = z.any().superRefine((value, ctx) => {
    const form = formOf(value, ctx);
    if (form === undefined) return;
    forwardIssues(variants[form].safeParse(value), ctx);
  });
  return z.record(subagentNameSchema, entry);
}
