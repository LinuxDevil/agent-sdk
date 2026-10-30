/**
 * The "not supported yet" marker issues of the AgentSpec v2 schema. Every
 * section of the spec that has not landed yet is a placeholder that accepts
 * an absent key but rejects any value with one of these issues, so a spec the
 * SDK cannot run is refused at validation time (LOUSHO_SPEC_UNSUPPORTED)
 * instead of failing at run time.
 */
import { z } from 'zod';

/** Every "not supported yet" issue message starts with this, so parseAgentSpecV2() can tell it from a plain validation problem. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas raising the same issues
export const UNSUPPORTED_PREFIX = 'not supported yet: ';

/** Adds an issue saying `what` cannot run on this SDK version yet; `path` is relative to the refined value. */
export function addUnsupportedIssue(ctx: z.RefinementCtx, what: string, path: (string | number)[] = []): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${UNSUPPORTED_PREFIX}${what}`, path });
}

/** Whether an issue was raised by {@link addUnsupportedIssue}. */
export function isUnsupportedIssue(issue: { message: string }): boolean {
  return issue.message.startsWith(UNSUPPORTED_PREFIX);
}

/** A top-level key whose section has not landed yet: absent is fine, any value is "not supported yet". */
export function pendingField(key: string) {
  // `.optional()` outermost on purpose: in zod 4 a checked `z.any()` reports an absent key as Required.
  return z
    .any()
    .superRefine((value, ctx) => {
      if (value !== undefined) addUnsupportedIssue(ctx, `'${key}' cannot be run by this version of the SDK`);
    })
    .optional();
}
