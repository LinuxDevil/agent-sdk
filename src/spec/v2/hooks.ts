/**
 * The `spec.hooks` section of AgentSpec v2: `{ id, file }` entries that load
 * hooks from a code file inside the agent's folder, and `{ id, inline }`
 * entries — JS function-body code a host-supplied runner (Studio's hook
 * sandbox) executes at one hook point. The SDK never evaluates `code` itself:
 * `resolve/hooks.ts` hands it to `host.inlineHook`. Browser-safe: no `node:*`
 * imports.
 */
import { z } from 'zod';
import { anyError } from '../../utils/zodCompat';
import { forwardIssues, refineUniqueIds, relativePathSchema, specIdSchema } from './common';

/** The AgentHook methods an inline hook's code may implement. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 consumers (Studio hook editor, canvas hook node)
export const HOOK_POINTS = ['preToolCall', 'postToolCall', 'preGenerate', 'postGenerate'] as const;

/** A {@link HOOK_POINTS} entry. */
export type HookPoint = (typeof HOOK_POINTS)[number];

/** An inline hook: JS function-body code run by the host's sandbox at one hook point. */
export interface InlineHookSpec {
  /** Display name; the registered AgentHook is named by the entry `id` instead. */
  name: string;
  /** The AgentHook method the code implements. */
  point: HookPoint;
  /** JavaScript function-body source the host's sandbox runs. */
  code: string;
  /** `false` leaves the hook out of the compiled agent. */
  enabled?: boolean;
}

/** One `spec.hooks` entry: a hook file inside the agent's folder or inline code, named by `id` (`hook:<id>` on the canvas). */
export type HookSpec = { id: string; file: string } | { id: string; inline: InlineHookSpec };

/** Longest `code` an inline hook may carry (a function body, not a file). */
export const MAX_INLINE_HOOK_CODE = 20_000;

const fileHook = z
  .object({
    id: specIdSchema,
    file: relativePathSchema.refine(
      (value) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(value),
      'must be a .ts, .mts, .cts, .js, .mjs or .cjs file'
    ),
  })
  .strict();

const inlineHook = z
  .object({
    id: specIdSchema,
    inline: z
      .object({
        name: z.string().min(1).max(64),
        point: z.enum(HOOK_POINTS, anyError("must be 'preToolCall', 'postToolCall', 'preGenerate' or 'postGenerate'")),
        code: z.string().max(MAX_INLINE_HOOK_CODE, `must be at most ${MAX_INLINE_HOOK_CODE} characters`),
        enabled: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/** The key that selects a {@link HookSpec}'s variant; exactly one must be present on each entry. */
const HOOK_KINDS = ['file', 'inline'] as const;

const VARIANTS: Record<(typeof HOOK_KINDS)[number], z.ZodTypeAny> = { file: fileHook, inline: inlineHook };

/**
 * One entry is a plain object with exactly one of `file`/`inline` (a `z.union`
 * would hide the inner messages), then that variant's own strict checks,
 * whose issues are forwarded at their own paths.
 */
function refineHookSpec(value: unknown, ctx: z.RefinementCtx): void {
  const kinds =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? HOOK_KINDS.filter((kind) => kind in value)
      : [];
  if (kinds.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must have exactly one of file, inline' });
    return;
  }
  forwardIssues(VARIANTS[kinds[0]].safeParse(value), ctx);
}

/**
 * One `spec.hooks` entry (zod): accepts any value and reports the HookSpec
 * rules itself, so the "exactly one kind" and per-variant issues point at the
 * right paths instead of a union's generic failure.
 */
// fallow-ignore-next-line unused-export -- composed by hookListSchema; exported for section schemas that embed it
export const hookSpecSchema = z.any().superRefine(refineHookSpec);

/** The `spec.hooks` list (zod): each entry's `id` must be unique. */
export const hookListSchema = z.array(hookSpecSchema).superRefine(refineUniqueIds);
