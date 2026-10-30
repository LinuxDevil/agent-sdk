/**
 * The `spec.permissions` section of AgentSpec v2: ordered permission rules,
 * each with a stable `id` (the `perm:<id>` node id), a `tool` name, `'*'`,
 * glob or list of those, an optional `when` argument matcher (the agent
 * directory's {@link WhenArgMatcher} operands), an `action` and an optional
 * `reason` / `ttlMs`. `resolve/permissions.ts` compiles them into
 * `createAgent({ permissions })` rules via the agent-directory converter, so
 * both formats behave the same. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import type { WhenArgMatcher } from '../../agentDir/validateConfig';
import { APPROVAL_TTL_RULE, isApprovalTtl } from '../../execution/permissions';
import { anyError } from '../../utils/zodCompat';
import { refineUniqueIds, specIdSchema } from './common';
import { addUnsupportedIssue } from './unsupported';

/** One `spec.permissions` entry (the SDK's serializable rule form plus a stable `id`). */
export interface PermissionRuleSpec {
  id: string;
  /** A tool name, '*', a glob ('github_*', 'read_?'), or a list of those. */
  tool: string | string[];
  /** Argument name → regular expression (string) or operator object; every entry must hold. */
  when?: Record<string, string | WhenArgMatcher>;
  /** 'auto' (model-decided) is not supported yet (R01). */
  action: 'allow' | 'deny' | 'ask' | 'auto';
  reason?: string;
  /** Only with action 'ask'. */
  ttlMs?: number;
}

/** Whether `pattern` compiles as a regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** A regular expression given as a string (a `when` entry, or an operator object's `matches`). */
const regexString = z.string().refine(compiles, 'is not a valid regular expression');

/** The operand an `eq` / `ne` operator takes. */
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The operand the numeric operators take. */
const num = z.number().finite();

/** A `when` entry's operator object: strict, and at least one operator must be set. */
const operatorObject = z
  .object({
    eq: scalar.optional(),
    ne: scalar.optional(),
    lt: num.optional(),
    lte: num.optional(),
    gt: num.optional(),
    gte: num.optional(),
    matches: regexString.optional(),
  })
  .strict()
  .refine((matcher) => Object.keys(matcher).length > 0, 'must set at least one of eq, ne, lt, lte, gt, gte, matches');

/** A `when` entry: a regular expression string or an operator object. */
const whenArgMatcher = z.union([regexString, operatorObject]);

/** A tool name, '*' or a glob using only '*' and '?' ('[', '{' and other glob syntax are not supported). */
const toolPattern = z.string().regex(/^[A-Za-z0-9_*?-]{1,128}$/, "must be a tool name, '*' or a glob using * and ?");

/** The `spec.permissions` entry checks a single rule schema cannot express. */
function refineRule(rule: PermissionRuleSpec, ctx: z.RefinementCtx): void {
  if (rule.ttlMs !== undefined && rule.action !== 'ask') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "only 'ask' rules wait for a decision; remove ttlMs",
      path: ['ttlMs'],
    });
  }
  if (rule.action === 'auto') {
    addUnsupportedIssue(ctx, "action 'auto' (model-decided approvals)", ['action']);
  }
}

/** One `spec.permissions` entry (zod): strict, `ttlMs` only on 'ask' rules, 'auto' not supported yet. */
// fallow-ignore-next-line unused-export -- composed by permissionListSchema; exported for section schemas that embed it
export const permissionRuleSchema = z
  .object({
    id: specIdSchema,
    tool: z.union([toolPattern, z.array(toolPattern).min(1)]),
    when: z
      .record(z.string().min(1), whenArgMatcher)
      .refine((when) => Object.keys(when).length > 0, 'must name at least one argument')
      .optional(),
    action: z.enum(['allow', 'deny', 'ask', 'auto'], anyError("must be 'allow', 'deny', 'ask' or 'auto'")),
    reason: z.string().min(1).optional(),
    ttlMs: z.number().refine(isApprovalTtl, `must be ${APPROVAL_TTL_RULE}`).optional(),
  })
  .strict()
  .superRefine(refineRule);

/** The `spec.permissions` list (zod): each id must be unique. */
export const permissionListSchema = z.array(permissionRuleSchema).superRefine(refineUniqueIds);
