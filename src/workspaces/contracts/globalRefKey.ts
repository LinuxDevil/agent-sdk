import { z } from 'zod';
import { parseAgentRef } from './agentRefs';

export const globalRefKeySchema = z.string().superRefine((key, ctx) => {
  if (!key.startsWith('global:')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `key '${key}' must be a global ref: 'global:<name>'` });
    return;
  }
  if (!parseAgentRef(`${key}@0.0.0`).ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `key '${key}' must be 'global:<name>' with a kebab-case name and no range` });
  }
});
