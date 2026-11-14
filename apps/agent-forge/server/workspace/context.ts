/**
 * Workspace context - the per-workspace stores a request's handlers use.
 *
 * Studio serves project folders ("workspaces"). Everything that lives
 * under `<workspace>/.lousho/agents/` - the agent store, the run manager
 * and the stores it owns, the chat trigger - is per-workspace, while
 * settings/secrets stay Studio-global (see studioPaths.ts). A route
 * handler never closes over a singleton: it reads its workspace's stores
 * from `workspaceOf(req)` (middleware.ts), which resolved the request's
 * workspace id into one of these contexts.
 *
 * Today there is exactly one context (`singleWorkspace`) - the folder
 * Studio was launched in; `WorkspaceResolver` is the seam a lazy,
 * registry-backed multi-workspace resolver plugs into later.
 */
import { TriggerRegistry } from 'lousho/triggers';
import { ALL_WORKSPACES, type WorkspaceRef } from '../../shared/workspace';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { withAgentLock } from '../storage/atomic';
import { DraftStore } from '../storage/draftStore';
import { createIdleVersioner, type IdleVersioner } from '../storage/idleVersioner';
import { SuggestionStore } from '../storage/suggestionStore';
import { VersionStore } from '../storage/versionStore';
import { ChatTriggerAdapter } from '../chatTriggerAdapter';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { StudioEventBus } from '../events/eventBus';
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import type { AgentHost } from '../host/agentHost';
import { RunManager } from '../runRegistry';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import type { PassRunner } from '../passes/passRunner';
import type { SpendLog } from '../passes/spendLog';
import type { AlertStore } from '../inbox/alertStore';
import { InboxService } from '../inbox/inboxService';
import { attachFailureStreak } from '../lifecycle/failureStreak';
import { attachVersionSummaries } from '../passes/versionSummary';
import { attachDraftReviews } from '../passes/draftReview';
import { createTriggerRuntime } from '../triggers/runtime';
import type { CronTriggers } from '../triggers/cronTriggers';
import type { TriggerHost } from '../triggers/triggerHost';

/** Everything a per-agent route needs for one workspace. */
export interface WorkspaceContext {
  ref: WorkspaceRef;
  /** This workspace's `.lousho/agents` storage: the spec v2 working copies and their meta/layout/working sidecars. */
  repo: AgentRepo;
  /** v1 facade over `repo` (fsAgentStore) - what the still-v1 routes and RunManager use. */
  agentStore: LegacyAgentStore;
  /** Append-only version history under `<id>/versions/` - captures and the external-edit baseline live here (storage/versionStore.ts). */
  versions: VersionStore;
  /** Pending + settled change drafts under `<id>/drafts/` (storage/draftStore.ts). */
  drafts: DraftStore;
  /**
   * The workspace's idle-version scheduler (storage/idleVersioner.ts):
   * `PUT /agents/:id` `touch`es it after each autosave write,
   * `POST /agents/:id/versions` and `DELETE /agents/:id` `cancel` it, and
   * server close `flushAll()`s it - so an edited agent gets an `editor`
   * version after 60 s of quiet.
   */
  idleVersioner: IdleVersioner;
  /** Prompt suggestions + cached portability analyses under `<id>/suggestions/` (storage/suggestionStore.ts). */
  suggestions: SuggestionStore;
  /** The host this workspace's agent runs execute through (InProcessAgentHost on Studio's SDK; a bridge host when the project has its own). */
  host: AgentHost;
  runs: RunManager;
  /** `'chat'` → `ChatTriggerAdapter(runs)`; `POST /agents/:id/message` goes through it (chatTriggerAdapter.ts). */
  chatTriggers: TriggerRegistry;
  /**
   * This workspace's Studio event bus (events/eventBus.ts): write routes
   * publish `StudioEvent`s here, `WS /events` fans them out to that
   * workspace's tabs. Per workspace, like the stores.
   */
  events: StudioEventBus;
  /**
   * The app's one PassRunner (passes/passRunner.ts) - Studio-global like
   * settings, shared by every workspace: background passes a route or
   * store kicks off enqueue here so dedupe, retries and the spend log
   * apply app-wide.
   */
  passes: PassRunner;
  /**
   * This workspace's inbox (inbox/inboxService.ts, R02a): the
   * approvals/questions/drafts/suggestions/alerts union `GET /inbox`
   * lists and `inbox.count` counts. Built and `start()`ed here;
   * `stop()` runs on `dispose()` (and `startStudioServer`'s `close()` for
   * the launch context).
   */
  inbox: InboxService;
  /**
   * This workspace's trigger host (triggers/triggerHost.ts, R08a): the
   * per-agent trigger queue webhook/channel/cron dispatches run through.
   * Built and `start()`ed here like the inbox; `stop()` runs on
   * `dispose()` (and `startStudioServer`'s `close()` for the launch
   * context).
   */
  triggers: TriggerHost;
  /**
   * This workspace's cron scheduler (triggers/cronTriggers.ts, R08c):
   * fires each agent's `cron` triggers through `triggers` on schedule.
   * Built and `start()`ed here; `stop()` is called by
   * `startStudioServer`'s `close()` for the launch context and by
   * `dispose()` for every context.
   */
  cron: CronTriggers;
  /**
   * Stops background work (the pass-attach subscriptions, the idle
   * versioner's pending captures, the inbox's recount subscriptions, the
   * trigger host and the cron scheduler) and closes nothing on disk.
   * Idempotent - `WorkspaceManager` calls it once per disposal and
   * `startStudioServer`'s `close()` may call the pieces again.
   */
  dispose(): Promise<void>;
}

/**
 * How a request's workspace id becomes a context. `singleWorkspace` is
 * the shipped implementation; a registry-backed manager that builds
 * contexts lazily replaces it behind this same interface.
 */
export interface WorkspaceResolver {
  /**
   * `undefined` and `ALL_WORKSPACES` resolve to the default workspace in
   * single-workspace mode (one workspace is all of them); an unknown id
   * resolves to `undefined` (the middleware answers 404).
   */
  resolve(id: string | undefined): Promise<WorkspaceContext | undefined>;
  defaultId(): string;
  /**
   * Keeps `id` warm until the returned release runs (open sockets, W02b).
   * `singleWorkspace` returns a no-op release - its one context is never
   * a disposal candidate anyway.
   */
  retain(id: string): () => void;
}

/** A resolver that serves exactly `ctx` - the launch folder, whatever id came in that names it. */
export function singleWorkspace(ctx: WorkspaceContext): WorkspaceResolver {
  return {
    resolve: (id) =>
      Promise.resolve(id === undefined || id === ALL_WORKSPACES || id === ctx.ref.id ? ctx : undefined),
    defaultId: () => ctx.ref.id,
    retain: () => () => {},
  };
}

/** Studio-global services every workspace context shares (constructed once while wiring). */
export interface WorkspaceServices {
  secretsStore: SecretsStore;
  settingsStore: SettingsStore;
  /** Report runs to the observe daemon (`true` in the studio, `false` in embeddings/tests). */
  observe: boolean;
  /** The app's one PassRunner, stamped onto every context this builds. */
  passRunner: PassRunner;
  /** The app's one spend log (R01b): auto-approval decisions append `auto_approval` records to it directly, off the PassRunner. */
  spendLog: SpendLog;
  /** The Studio-global inbox alert store (L12) every workspace's failure-streak pass writes to. */
  alerts: AlertStore;
}

/**
 * `POST /agents/:id/message` is dispatched through a `TriggerRegistry`
 * rather than calling `RunManager.sendMessage()` directly - see
 * chatTriggerAdapter.ts for why that is a behavior-preserving wrapper.
 */
export function chatTriggersFor(runs: RunManager): TriggerRegistry {
  const registry = new TriggerRegistry();
  registry.register('chat', new ChatTriggerAdapter(runs));
  return registry;
}

/**
 * Builds the stores and `RunManager` for one folder - the same wiring
 * `startStudioServer` did inline, unchanged, so a second workspace is a
 * second call rather than new code. `services` are the Studio-global
 * stores the runs share across workspaces.
 */
export function createWorkspaceContext(ref: WorkspaceRef, services: WorkspaceServices): WorkspaceContext {
  const repo = new AgentRepo(ref.root);
  const agentStore = createFsAgentStore(ref.root, repo);
  const versions = new VersionStore(repo);
  const suggestions = new SuggestionStore(repo);
  // One checkpoint/approval store pair per workspace, shared by the run
  // manager (history/compare/fork) and the agent host (the run's own
  // checkpoints and approval pauses).
  const checkpointStore = new FileCheckpointStore(ref.root);
  const approvalStore = new FileApprovalStore(ref.root);
  const host = new InProcessAgentHost({
    baseDir: ref.root,
    checkpointStore,
    approvalStore,
    secretsStore: services.secretsStore,
    settings: services.settingsStore,
    spend: services.spendLog,
  });
  const runs = new RunManager({
    baseDir: ref.root,
    checkpointStore,
    approvalStore,
    host,
    loadSpec: (agentId) => repo.readSpec(agentId),
    // A run-supplied spec becomes the working copy: baselined first if the
    // yaml changed on disk, written under the per-agent lock.
    saveSpec: (agentId, spec) =>
      withAgentLock(agentId, async () => {
        await versions.reconcileExternalEdit(agentId);
        await repo.writeSpec(agentId, spec);
      }),
    secretsStore: services.secretsStore,
    settingsStore: services.settingsStore,
    // Builder runs report to the observe daemon, so "Open trace" resolves.
    ...(services.observe ? { observe: true as const } : {}),
  });
  const events = new StudioEventBus();
  const drafts = new DraftStore(repo);
  // The version-summary pass (L04): every written version enqueues its
  // `version_summary` job on the app's one PassRunner.
  const detachVersionSummaries = attachVersionSummaries({
    versions,
    passRunner: services.passRunner,
    events,
    secretsStore: services.secretsStore,
    settings: services.settingsStore,
    workspaceId: ref.id,
  });
  // The draft auto-review pass (L11a): every created/restated pending
  // draft enqueues its `draft_review` job.
  const detachDraftReviews = attachDraftReviews({
    drafts,
    repo,
    passRunner: services.passRunner,
    events,
    secretsStore: services.secretsStore,
    settings: services.settingsStore,
    workspaceId: ref.id,
  });
  // The triggered-run failure streak (L12): five consecutive failed
  // 'trigger' runs auto-disable the agent and raise an inbox alert; the
  // AlertStore is Studio-global, everything else is this workspace's.
  const detachFailureStreak = attachFailureStreak({ runManager: runs, repo, alerts: services.alerts, events, workspaceId: ref.id });
  // The inbox (R02a): one service per workspace over this context's own
  // stores plus the Studio-global alert list (filtered to ref.id). It
  // `start()`s its recount subscriptions here; `close()` stops the
  // launch context's (index.ts).
  const inbox = new InboxService({
    repo,
    runManager: runs,
    approvalStore,
    drafts,
    suggestions,
    alerts: services.alerts,
    events,
    workspaceId: ref.id,
  });
  inbox.start();
  // The trigger host (R08a) + cron scheduler (R08c): webhook/cron
  // dispatches queue through this workspace's RunManager; trigger-phase
  // log lines land on the same run-log stream RunManager's entries use.
  const { triggers, cron } = createTriggerRuntime({ baseDir: ref.root, repo, runManager: runs, events });
  const idleVersioner = createIdleVersioner(versions);
  const detachPasses = [detachVersionSummaries, detachDraftReviews, detachFailureStreak];
  let disposed = false;
  return {
    ref,
    repo,
    agentStore,
    versions,
    drafts,
    idleVersioner,
    suggestions,
    host,
    runs,
    chatTriggers: chatTriggersFor(runs),
    events,
    passes: services.passRunner,
    inbox,
    triggers,
    cron,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const detach of detachPasses) detach();
      inbox.stop();
      triggers.stop();
      cron.stop();
      // Flush pending idle-version captures before the stores go quiet -
      // the same graceful stop `startStudioServer`'s `close()` performs.
      await idleVersioner.flushAll();
    },
  };
}
