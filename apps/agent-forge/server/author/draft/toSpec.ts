/**
 * Turning what the Author sent into a validated `AgentSpecV2` (PLAN §8.2):
 * `draftToSpec` for creates, `applyAuthorPatch` for the keep / replace /
 * clear / reset patch semantics of edits, `draftInvalidFailure` for the
 * `DRAFT_INVALID` tool result, and `deriveAgentId` for name → id.
 *
 * Both builders add the chat-trigger backstop (every agent can be tried
 * from the chat pane) and validate with the SDK's `agentSpecV2Schema` -
 * the same gate a saved spec passes, so a proposal can never hold a spec
 * Studio could not store. Catalog checks (is the model real, is the tool
 * known) and diffs are the propose tools' job, not this layer's.
 */
import { agentSpecV2Schema } from 'lousho';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolFailure } from '../../../shared/authorWire';
import { toolFailure } from '../tools/failure';
import type { AuthorDraft, AuthorPatch } from './schema';

/** One spec validation problem, flattened to `path: message` (array indexes as `[n]`). */
export interface SpecIssue {
  path: string;
  message: string;
}

/**
 * What `draftToSpec` / `applyAuthorPatch` yield: the validated spec, or
 * the issues a propose tool turns into a `DRAFT_INVALID` failure with
 * {@link draftInvalidFailure}.
 */
export type SpecBuildResult = { ok: true; spec: AgentSpecV2 } | { ok: false; issues: SpecIssue[] };

/** An issue as the published `SafeParser` reports it (structural, like draftRoutes' SpecSchemaIssue). */
interface SpecSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** `['tools', 2, 'builtin']` → `tools[2].builtin`; an empty path is `(root)`. */
function flattenPath(issue: SpecSchemaIssue): string {
  let path = '';
  for (const segment of issue.path ?? []) {
    const part = typeof segment === 'object' ? segment.key : segment;
    path += typeof part === 'number' ? `[${part}]` : path === '' ? String(part) : `.${String(part)}`;
  }
  return path === '' ? '(root)' : path;
}

/**
 * `agentSpecV2Schema.safeParse` of a candidate spec as a
 * {@link SpecBuildResult}. Exported for the save path (proposal/save.ts),
 * which re-validates a stored card's spec with today's schema the same
 * way a draft is validated at propose time.
 */
export function validateSpec(candidate: unknown): SpecBuildResult {
  const parsed = agentSpecV2Schema.safeParse(candidate);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({ path: flattenPath(issue), message: issue.message })),
  };
}

/**
 * Every agent keeps a chat trigger: when `spec.triggers` is a list without
 * a `type: 'chat'` entry, replaces it with a copy ending in
 * `{ id: 't<n>', type: 'chat' }` where `n` is the first `t` id not taken
 * (a copy, not a push - `spec` is a shallow spread of the caller's draft
 * or base spec, so pushing would write into their `triggers` array);
 * an absent `triggers` becomes just the chat trigger. A `triggers` that
 * is not a list is left alone - the schema reports it.
 */
function ensureChatTrigger(spec: Record<string, unknown>): void {
  const triggers = spec.triggers;
  if (triggers === undefined) {
    spec.triggers = [{ id: 't1', type: 'chat' }];
    return;
  }
  if (!Array.isArray(triggers)) return;
  const hasChat = triggers.some(
    (trigger) => typeof trigger === 'object' && trigger !== null && (trigger as { type?: unknown }).type === 'chat'
  );
  if (hasChat) return;
  const usedIds = new Set(
    triggers.map((trigger) => (typeof trigger === 'object' && trigger !== null ? (trigger as { id?: unknown }).id : undefined))
  );
  let n = 1;
  while (usedIds.has(`t${n}`)) n += 1;
  spec.triggers = [...triggers, { id: `t${n}`, type: 'chat' }];
}

/**
 * `proposeAgent`'s draft as a spec: `{ version: 2, ...draft }` plus the
 * chat-trigger backstop, validated. The draft schema already checked the
 * shape; this validation is what makes the result storable.
 */
export function draftToSpec(draft: AuthorDraft): SpecBuildResult {
  const candidate: Record<string, unknown> = { version: 2, ...draft };
  ensureChatTrigger(candidate);
  return validateSpec(candidate);
}

/**
 * `proposeAgentUpdate`'s patch over the current spec (PLAN §8.2): an
 * omitted key keeps the base value, `null` deletes the key (reset to
 * default) and any other value replaces it - a list replaces the whole
 * list, `[]` clears it. The merge gets the chat-trigger backstop and the
 * same validation a draft gets, so a patch can never produce a spec the
 * schema rejects.
 */
export function applyAuthorPatch(base: AgentSpecV2, patch: AuthorPatch): SpecBuildResult {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  ensureChatTrigger(merged);
  return validateSpec(merged);
}

/**
 * The `DRAFT_INVALID` failure for a rejected build: the first ten issues
 * as `path: message` for the model, one plain sentence for the person
 * (the card stays hidden while the Author fixes its own draft).
 */
export function draftInvalidFailure(
  toolName: 'proposeAgent' | 'proposeAgentUpdate',
  issues: SpecIssue[]
): AuthorToolFailure {
  const detail = issues
    .slice(0, 10)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return toolFailure(
    'DRAFT_INVALID',
    `The draft does not match AgentSpec v2: ${detail}.`,
    'The draft had a few invalid settings. The Author is fixing them.',
    `Fix the fields listed and call ${toolName} again. Use listTools, listGuardrails and listTriggerTypes for valid values.`
  );
}

/** The longest a derived agent id's slug may be, before the collision suffix. */
const AGENT_ID_SLUG_MAX = 48;

/**
 * A draft's human name as an agent id: lowercase, runs of non `[a-z0-9]`
 * collapsed to `-`, edge `-`s trimmed, capped at 48 characters, `'agent'`
 * when nothing usable remains - then `-2`, `-3`, ... while `taken` holds
 * the id. Every output is a valid {@link isValidAgentId} id.
 */
export function deriveAgentId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, AGENT_ID_SLUG_MAX)
      .replace(/-+$/g, '') || 'agent';
  let id = slug;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${slug}-${suffix}`;
  }
  return id;
}
