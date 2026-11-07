/**
 * `createAuthorServices` - the one wiring call that assembles the Author's
 * production pieces: the `AuthorTurnRunner` (real system prompt and tool
 * surface) plus `applyCard`, the Apply-button write path behind
 * `POST /assistant/sessions/:id/save`.
 *
 * `createApp` builds its default runner through this, and the AA21 eval
 * harness builds the same object over a temp workspace - so the scripted
 * conversations run the production turn runner, tools and Apply write
 * path, never a parallel implementation. Callers hand in the
 * Studio-global stores and the workspace resolver they already hold; the
 * seams (`providerFor`, `reviewDraft`, `mcpConnect`) exist for tests and
 * the eval's `--mock`/`--no-review` modes.
 */
import type { LLMProvider } from 'lousho';
import type { connectMcp } from 'lousho/mcp';
import type { AuthorSession } from '../../shared/authorWire';
import type { SettingsStore } from '../settingsStore';
import type { SecretsStore } from '../secretsStore';
import type { TemplateCatalog } from '../templates/templateCatalog';
import type { WorkspaceResolver } from '../workspace/context';
import { applyStoredProposal, type ApplyProposalOutcome } from './applyProposal';
import type { ReviewDraft } from './proposal/review';
import type { AuthorSessionStore } from './sessionStore';
import type { AuthorTurnRunner } from './turnRunner';
import { createAuthorRunner } from './wiring';

/** Everything {@link createAuthorServices} needs - the same deps `createApp` already holds at wiring time. */
export interface CreateAuthorServicesOptions {
  sessions: AuthorSessionStore;
  settings: SettingsStore;
  secrets: SecretsStore;
  templates: TemplateCatalog;
  /** The bundled SDK docs folder `searchDocs` indexes. */
  docsDir: string;
  /** Session `workspaceId` -> the workspace its turns edit agents in (PLAN §19.3). */
  workspaceResolver: WorkspaceResolver;
  /** Test seam for the `probeMcpServer` tool; defaults to the SDK's `connectMcp`. */
  mcpConnect?: typeof connectMcp;
  /** Test/eval seam: resolves the turn provider without the stored/env key lookup. */
  providerFor?: (model: string) => LLMProvider;
  /**
   * The draft review propose tools run before showing a card (PLAN §8.4).
   * Defaults to `passReview` (always-approve) like `createApp`'s wiring;
   * the eval's `--no-review` passes `passReview` explicitly for speed.
   */
  reviewDraft?: ReviewDraft;
}

/** The Author's production services: the turn runner and the Apply write path. */
export interface AuthorServices {
  runner: AuthorTurnRunner;
  /**
   * `POST /assistant/sessions/:id/save`'s write path minus the HTTP guards:
   * writes the stored card `proposalId` names and appends the `uiEvent`
   * save message. The caller handles concurrency (a running turn, a
   * racing Apply) - the route holds `savesInFlight`, the eval harness
   * applies only between finished turns.
   */
  applyCard: (session: AuthorSession, proposalId: string) => Promise<ApplyProposalOutcome>;
}

/**
 * Builds the Author's runner and Apply path over the caller's stores -
 * the production path `createApp` and the eval harness share.
 */
export function createAuthorServices(deps: CreateAuthorServicesOptions): AuthorServices {
  return {
    runner: createAuthorRunner({
      sessions: deps.sessions,
      settings: deps.settings,
      secrets: deps.secrets,
      templates: deps.templates,
      docsDir: deps.docsDir,
      workspaceResolver: deps.workspaceResolver,
      ...(deps.mcpConnect ? { mcpConnect: deps.mcpConnect } : {}),
      ...(deps.providerFor ? { providerFor: deps.providerFor } : {}),
      ...(deps.reviewDraft ? { reviewDraft: deps.reviewDraft } : {}),
    }),
    applyCard: (session, proposalId) =>
      applyStoredProposal({ sessions: deps.sessions, workspaceResolver: deps.workspaceResolver }, session, proposalId),
  };
}
