import { z } from 'zod';
import { modelIdSchema } from '../../spec/v2/common';
import { KEBAB_CASE } from './common';
import { checkForbiddenKeys, type ForbiddenKeyError, type ForbiddenKeyRule } from './forbiddenKeys';
import { isVersionRange } from './versionRange';

/** A parsed agent reference. */
export type AgentRef =
  | {
      /** A workspace-level agent, `<workspace>/agents/<name>/`. */
      kind: 'workspace';
      /** Agent folder name, kebab-case. */
      name: string;
    }
  | {
      /** A page-local agent, `pages/<p>/agents/<name>/`. */
      kind: 'local';
      /** Agent folder name, kebab-case. */
      name: string;
    }
  | {
      /** A Forge-project agent, pinned by version range. */
      kind: 'global';
      /** Agent name, kebab-case. */
      name: string;
      /** Version range: exact `x.y.z`, `^x.y.z` or `~x.y.z`. */
      range: string;
    };

/** The outcome of {@link parseAgentRef}: the parsed reference, or why the text is not one. */
export type ParseAgentRefResult =
  | {
      /** True when the text is a valid reference. */
      ok: true;
      /** The parsed reference. */
      ref: AgentRef;
    }
  | {
      /** False when the text is not a valid reference. */
      ok: false;
      /** Why the text is not a valid reference. */
      error: string;
    };

/** Display labels the Studio uses for agent-owned settings; not key paths. */
export const AGENT_OWNED = ['instructions', 'skills', 'tools', 'memory', 'default model'] as const;

/** Display labels the Studio uses for page-owned settings; not key paths. */
export const PAGE_OWNED = ['as', 'role', 'model', 'limits', 'tools.only', 'harness'] as const;

const NAME = new RegExp(KEBAB_CASE.source);

const FORM_HELP = "use 'workspace:<name>', 'local:<name>' or 'global:<name>@<range>'";

/** `workspace:<name>` | `local:<name>` | `global:<name>@<range>`; prefix required; range is `x.y.z`, `^x[.y[.z]]` or `~x[.y[.z]]`. */
export function parseAgentRef(ref: string): ParseAgentRefResult {
  const colon = ref.indexOf(':');
  if (colon === -1) return { ok: false, error: `agent reference '${ref}' needs a prefix: ${FORM_HELP}` };
  const kind = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  if (kind !== 'workspace' && kind !== 'local' && kind !== 'global') {
    return { ok: false, error: `unknown agent reference prefix '${kind}': ${FORM_HELP}` };
  }
  if (kind === 'global') {
    const at = rest.indexOf('@');
    if (at === -1) return { ok: false, error: `global reference '${ref}' needs a version range: global:<name>@<range>, e.g. global:${rest}@^1.0.0` };
    const name = rest.slice(0, at);
    const range = rest.slice(at + 1);
    if (!NAME.test(name)) return { ok: false, error: `agent name '${name}' must be kebab-case` };
    if (!isVersionRange(range)) return { ok: false, error: `version range '${range}' must be an exact x.y.z, ^x.y.z or ~x.y.z` };
    return { ok: true, ref: { kind, name, range } };
  }
  if (!NAME.test(rest)) {
    return { ok: false, error: `agent name '${rest}' must be kebab-case with no path separators or version (${kind} references take no range)` };
  }
  return { ok: true, ref: { kind, name: rest } };
}

/** One agent attached to a page in `agents.json`. */
export interface Attachment {
  /** Alias the page uses for this agent, unique within the page. */
  as: string;
  /** Agent reference: `workspace:<name>`, `local:<name>` or `global:<name>@<range>`. */
  ref: string;
  /** Text shown to the lead or the workflow describing what this agent does here. */
  role?: string;
  /** Provider and model for this agent on this page, as `provider/model`. */
  model?: string;
  /** Limits for this agent on this page; they can only tighten the agent's own. */
  limits?: {
    /** Longest wall-clock time of one run, in milliseconds. */
    maxDurationMs?: number;
    /** Most model turns in one run. */
    maxTurns?: number;
    /** Spend cap in US dollars for one run. */
    maxCostUsd?: number;
  };
  /** Tool narrowing; a page can never add tools. */
  tools?: {
    /** Only these tools stay available to the agent on this page. */
    only?: string[];
  };
}

/** The `agents.json` file (`lousho.agents/1`): the agents attached to one page. */
export interface Attachments {
  /** Schema id; always `lousho.agents/1`. */
  schema: 'lousho.agents/1';
  /** Attached agents, in order. */
  agents: Attachment[];
}

const agentOwnedMessage = (at: string): string => `${at}: agent-owned settings live in the agent, not the attachment (R13)`;

const ATTACHMENT_KEY_RULES: readonly ForbiddenKeyRule[] = [{ keys: ['permissions', 'secrets', 'instructions', 'add'], message: agentOwnedMessage }];

const nonEmpty = z.string().min(1, 'must not be empty');

const attachmentObjectSchema = z
  .object({
    as: z.string().regex(KEBAB_CASE, 'must be a kebab-case alias'),
    ref: z.string().superRefine((value, ctx) => {
      const parsed = parseAgentRef(value);
      if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
    }),
    role: nonEmpty.optional(),
    model: modelIdSchema.optional(),
    limits: z
      .object({ maxDurationMs: z.number().int().positive().optional(), maxTurns: z.number().int().positive().optional(), maxCostUsd: z.number().positive().optional() })
      .strict()
      .optional(),
    tools: z.object({ only: z.array(nonEmpty).optional() }).strict().optional(),
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function removeAt(root: unknown, path: (string | number)[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), root);
  if (isRecord(parent)) delete parent[path[path.length - 1]];
}

function withoutErrorKeys(data: unknown, errors: ForbiddenKeyError[]): unknown {
  errors.forEach((error) => removeAt(data, error.path));
  return data;
}

const reportError = (ctx: z.RefinementCtx) => (error: ForbiddenKeyError) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: error.path });

const reissue = (ctx: z.RefinementCtx) => (issue: z.ZodIssue) => ctx.addIssue({ ...issue, path: issue.path });

const attachmentSchema = z.unknown().transform((value, ctx) => {
  const { errors, data } = checkForbiddenKeys(value, ATTACHMENT_KEY_RULES, 'attachment');
  errors.forEach(reportError(ctx));
  const parsed = attachmentObjectSchema.safeParse(withoutErrorKeys(data, errors));
  if (parsed.success) return parsed.data;
  parsed.error.issues.forEach(reissue(ctx));
  return z.NEVER;
});

const aliasOf = (agent: { as?: unknown } | undefined): unknown => agent?.as;

function duplicateIndexes(agents: ({ as?: unknown } | undefined)[]): number[] {
  const aliases = agents.map(aliasOf);
  return aliases.flatMap((alias, index) => (typeof alias === 'string' && aliases.indexOf(alias) !== index ? [index] : []));
}

const reportDuplicates = (agents: { as: string }[], ctx: z.RefinementCtx): void =>
  duplicateIndexes(agents).forEach((index) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate alias '${agents[index].as}'`, path: [index, 'as'] }));

export const attachmentsObjectSchema = z
  .object({
    schema: z.literal('lousho.agents/1'),
    agents: z.array(attachmentSchema).superRefine(reportDuplicates),
  })
  .strict();

/** Zod schema for `agents.json` (`lousho.agents/1`); aliases are unique, refs are validated, and keys that would grant or override agent-owned settings are errors (R13). */
export const attachmentsSchema: z.ZodType<Attachments> = attachmentsObjectSchema as unknown as z.ZodType<Attachments>;
