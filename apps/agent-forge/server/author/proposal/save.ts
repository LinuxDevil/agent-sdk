/**
 * The one write path behind the Author's save tools and the card's Apply
 * button (PLAN §8.3, AA10b): `writeProposal` writes EXACTLY the stored
 * card's spec - re-validated with today's `agentSpecV2Schema`, never a
 * re-sent copy and never the model's tool input - captures a
 * `source: 'author'` version carrying the user text that asked for the
 * card, saves new agents disabled, and links created agents back to the
 * session. Every failure is a returned `AuthorToolFailure`, never thrown
 * (a throwing store becomes `WRITE_FAILED`).
 *
 * The durable proposal store is the session transcript; the gate
 * (gate.ts) decides WHICH card may save - this module only performs the
 * write itself once a caller has resolved one.
 */
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type {
  AuthorMessage,
  AuthorToolFailure,
  ProposalOutput,
} from '../../../shared/authorWire';
import type { VersionListItem } from '../../../shared/wireTypes';
import type { StudioEventBus } from '../../events/eventBus';
import { defaultMeta, type AgentRepo } from '../../storage/agentRepo';
import { withAgentLock } from '../../storage/atomic';
import { specHash } from '../../storage/specHash';
import type { VersionStore } from '../../storage/versionStore';
import { deriveAgentId, validateSpec } from '../draft/toSpec';
import type { AuthorSessionStore } from '../sessionStore';
import {
  agentGoneFailure,
  baseChangedFailure,
  invalidStoredProposalFailure,
  writeFailedFailure,
} from './failures';
import type { ProposalIdentity } from './turnState';

/** The longest `requestText` a write stamps on its version (PLAN §4, 400 chars). */
const REQUEST_TEXT_MAX = 400;

/**
 * The stores and per-save facts `writeProposal` needs. `agents`,
 * `versions` and `bus` come off the session's `WorkspaceContext` (the
 * PLAN §19.3 seam - resolved by the caller from `session.workspaceId`,
 * never a closed-over singleton); `sessions` is the Studio-global
 * `AuthorSessionStore` so a create can record `createdAgentIds`.
 */
export interface WriteContext {
  sessionId: string;
  /** The user text that led to the card (`requestTextFor`), already cut. */
  requestText: string | null;
  agents: AgentRepo;
  versions: VersionStore;
  sessions: AuthorSessionStore;
  bus?: StudioEventBus;
}

/** `writeProposal`'s answer: the saved agent's id/version/name/enabled, or why it refused. */
export type SaveResult =
  | { ok: true; agentId: string; version: number; name: string; enabled: boolean }
  | AuthorToolFailure;

/**
 * The last non-empty user text before the assistant message holding
 * `proposalId`, cut to 400 chars ('…' when cut). `uiEvent` user messages
 * are skipped - they are app-written save/secret markers, not something
 * the user asked for. `null` when no card carries the id or no user text
 * precedes it.
 */
export function requestTextFor(messages: readonly AuthorMessage[], proposalId: string): string | null {
  let lastUserText: string | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.uiEvent === undefined && message.text.trim() !== '') lastUserText = message.text;
      continue;
    }
    const holdsCard = message.parts.some((part) => part.type === 'tool' && part.toolCallId === proposalId);
    if (holdsCard) {
      if (lastUserText === null) return null;
      return lastUserText.length > REQUEST_TEXT_MAX
        ? `${lastUserText.slice(0, REQUEST_TEXT_MAX - 1)}…`
        : lastUserText;
    }
  }
  return null;
}

/** The `{ ok: true }` half of a save: the version number (a no-op update re-uses the latest) and the bus event. */
async function savedResult(
  ctx: WriteContext,
  agentId: string,
  name: string,
  enabled: boolean,
  captured: VersionListItem | null
): Promise<SaveResult> {
  // `capture` returns null only for a no-op update, which by definition
  // has a latest item to fall back to.
  const item = captured ?? (await ctx.versions.latest(agentId));
  if (item === undefined) throw new Error(`Version capture for '${agentId}' recorded nothing.`);
  ctx.bus?.publish({ type: 'agent.changed', agentId, reason: 'version' });
  return { ok: true, agentId, version: item.version, name, enabled };
}

/**
 * The create branch: a fresh id from the card's name, then spec + meta +
 * version 1 inside the new agent's lock - disabled, `createdFrom`
 * pointing back at the Author session. `sessions.update` runs AFTER the
 * lock is released (it takes the `author:` lock itself).
 */
async function writeCreate(spec: AgentSpecV2, ctx: WriteContext): Promise<SaveResult> {
  const id = deriveAgentId(spec.name, new Set(ctx.agents.listIds()));
  let captured: VersionListItem | null = null;
  await withAgentLock(id, async () => {
    await ctx.agents.writeSpec(id, spec);
    await ctx.agents.writeMeta(id, {
      ...defaultMeta(new Date().toISOString()),
      enabled: false,
      createdFrom: { kind: 'author', ref: ctx.sessionId },
    });
    captured = await ctx.versions.capture(id, {
      kind: 'create',
      source: 'author',
      requestText: ctx.requestText,
      authorSessionId: ctx.sessionId,
    });
  });
  await ctx.sessions.update(ctx.sessionId, (s) => ({
    ...s,
    createdAgentIds: s.createdAgentIds.includes(id) ? s.createdAgentIds : [...s.createdAgentIds, id],
  }));
  return savedResult(ctx, id, spec.name, false, captured);
}

/**
 * The update branch: inside the agent's lock, the working copy must still
 * exist (`AGENT_GONE`) and still hash to the card's `baseSpecHash`
 * (`BASE_CHANGED` - a canvas edit after the card was shown) before the
 * stored spec is written and versioned.
 */
async function writeUpdate(agentId: string, spec: AgentSpecV2, output: ProposalOutput, ctx: WriteContext): Promise<SaveResult> {
  let captured: VersionListItem | null = null;
  let enabled = false;
  let refusal: AuthorToolFailure | undefined;
  await withAgentLock(agentId, async () => {
    const current = await ctx.agents.readSpec(agentId);
    if (current === undefined) {
      refusal = agentGoneFailure(agentId);
      return;
    }
    if (specHash(current) !== output.baseSpecHash) {
      refusal = baseChangedFailure(agentId);
      return;
    }
    enabled = (await ctx.agents.readMeta(agentId)).enabled;
    await ctx.agents.writeSpec(agentId, spec);
    captured = await ctx.versions.capture(agentId, {
      kind: 'update',
      source: 'author',
      requestText: ctx.requestText,
      authorSessionId: ctx.sessionId,
    });
  });
  if (refusal !== undefined) return refusal;
  return savedResult(ctx, agentId, spec.name, enabled, captured);
}

/**
 * The one write path for model saves and the Apply button (PLAN §8.3):
 * re-validates the stored card's spec (`INVALID_STORED_PROPOSAL`), then
 * writes it exactly. Any thrown error becomes `WRITE_FAILED` - a save
 * refuses by returning, never by throwing.
 */
export async function writeProposal(
  identity: ProposalIdentity,
  output: ProposalOutput,
  ctx: WriteContext
): Promise<SaveResult> {
  const built = validateSpec(output.spec);
  if (!built.ok) return invalidStoredProposalFailure(built.issues);
  try {
    if (identity.kind === 'create') return await writeCreate(built.spec, ctx);
    return await writeUpdate(identity.agentId, built.spec, output, ctx);
  } catch (error) {
    return writeFailedFailure(error instanceof Error ? error.message : String(error));
  }
}
