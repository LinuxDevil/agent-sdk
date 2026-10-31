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
import { TriggerRegistry } from '@lousho/build-ai-agent/triggers';
import { ALL_WORKSPACES, type WorkspaceRef } from '../../shared/workspace';
import type { AgentStore } from '../../src/persistence/AgentStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { ChatTriggerAdapter } from '../chatTriggerAdapter';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { RunManager } from '../runRegistry';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';

/** Everything a per-agent route needs for one workspace. */
export interface WorkspaceContext {
  ref: WorkspaceRef;
  /** This workspace's `.lousho/agents` storage: the spec v2 working copies and their meta/layout/working sidecars. */
  repo: AgentRepo;
  /** v1 facade over `repo` (fsAgentStore) - what the still-v1 routes and RunManager use. */
  agentStore: AgentStore;
  runs: RunManager;
  /** `'chat'` → `ChatTriggerAdapter(runs)`; `POST /agents/:id/message` goes through it (chatTriggerAdapter.ts). */
  chatTriggers: TriggerRegistry;
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
}

/** A resolver that serves exactly `ctx` - the launch folder, whatever id came in that names it. */
export function singleWorkspace(ctx: WorkspaceContext): WorkspaceResolver {
  return {
    resolve: (id) =>
      Promise.resolve(id === undefined || id === ALL_WORKSPACES || id === ctx.ref.id ? ctx : undefined),
    defaultId: () => ctx.ref.id,
  };
}

/** Studio-global services every workspace context shares (constructed once while wiring). */
export interface WorkspaceServices {
  secretsStore: SecretsStore;
  settingsStore: SettingsStore;
  /** Report runs to the observe daemon (`true` in the studio, `false` in embeddings/tests). */
  observe: boolean;
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
  const runs = new RunManager({
    baseDir: ref.root,
    checkpointStore: new FileCheckpointStore(ref.root),
    approvalStore: new FileApprovalStore(ref.root),
    loadSpec: (agentId) => agentStore.load(agentId),
    saveSpec: (agentId, spec) => agentStore.save(agentId, spec),
    secretsStore: services.secretsStore,
    settingsStore: services.settingsStore,
    // Builder runs report to the observe daemon, so "Open trace" resolves.
    ...(services.observe ? { observe: true as const } : {}),
  });
  return { ref, repo, agentStore, runs, chatTriggers: chatTriggersFor(runs) };
}
