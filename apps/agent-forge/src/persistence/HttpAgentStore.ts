import type { AgentSpec } from '@lousho/build-ai-agent';
import type { AgentStore, AgentStoreEntry } from './AgentStore';

/** The slice of `RuntimeClient` this store needs (injectable for tests). */
export interface AgentApi {
  listAgents(): Promise<AgentStoreEntry[]>;
  loadAgent(id: string): Promise<AgentSpec | undefined>;
  saveAgent(id: string, spec: AgentSpec): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  workspace(): Promise<{ baseDir: string }>;
}

const DRAFT_PREFIX = 'agent-forge:draft:';

interface Draft {
  spec: AgentSpec;
  savedAt: string;
}

function isApiError(error: unknown): boolean {
  return typeof (error as { status?: unknown } | undefined)?.status === 'number';
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Eve DUI-F2: the studio's `AgentStore`, backed by the server's
 * `GET/PUT/DELETE /agents` (`.lousho/agents/*.yaml` in the directory
 * `lousho studio` was started in). It replaces the old browser-only
 * `LocalStorageAgentStore`, whose list was shared by every project opened
 * in the same browser, never showed agents already on disk, and left a new
 * agent unknown to the server so chat failed until Run (DUI-F7).
 *
 * `localStorage` is only a draft cache: a save that can't reach the server
 * is kept under a key that includes the server's workspace directory, and is
 * pushed (or, if the server is still down, returned) on the next load of
 * that agent - so unsaved edits survive a restart without leaking into
 * another project's studio.
 */
export class HttpAgentStore implements AgentStore {
  private workspaceKey: Promise<string> | undefined;

  constructor(
    private readonly api: AgentApi,
    private readonly storage: Storage | undefined = defaultStorage()
  ) {}

  private draftKey(id: string): Promise<string> {
    this.workspaceKey ??= this.api.workspace().then(
      ({ baseDir }) => baseDir,
      (error) => {
        this.workspaceKey = undefined; // retry next time
        throw error;
      }
    );
    return this.workspaceKey.then((baseDir) => `${DRAFT_PREFIX}${baseDir}:${id}`);
  }

  private async readDraft(id: string): Promise<Draft | undefined> {
    if (!this.storage) return undefined;
    try {
      const raw = this.storage.getItem(await this.draftKey(id));
      return raw ? (JSON.parse(raw) as Draft) : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeDraft(id: string, spec: AgentSpec): Promise<void> {
    if (!this.storage) return;
    try {
      const draft: Draft = { spec, savedAt: new Date().toISOString() };
      this.storage.setItem(await this.draftKey(id), JSON.stringify(draft));
    } catch {
      // No workspace (server down) or storage full/blocked: nothing to cache under.
    }
  }

  private async clearDraft(id: string): Promise<void> {
    if (!this.storage) return;
    try {
      this.storage.removeItem(await this.draftKey(id));
    } catch {
      // Same as writeDraft.
    }
  }

  list(): Promise<AgentStoreEntry[]> {
    // Learn the workspace while the server is up, so a later offline save
    // still has a key to cache its draft under.
    this.draftKey('').catch(() => {});
    return this.api.listAgents();
  }

  async load(id: string): Promise<AgentSpec | undefined> {
    const draft = await this.readDraft(id);
    if (draft) {
      // An edit that never reached the server: push it now, or keep showing it.
      try {
        await this.api.saveAgent(id, draft.spec);
        await this.clearDraft(id);
      } catch {
        // Still offline - the draft stays cached and wins over the server copy.
      }
      return draft.spec;
    }
    return this.api.loadAgent(id);
  }

  async save(id: string, spec: AgentSpec): Promise<void> {
    try {
      await this.api.saveAgent(id, spec);
    } catch (error) {
      // Only an unreachable server makes a draft; a rejected spec (an API
      // error with a status) would just fail again on every load.
      if (!isApiError(error)) await this.writeDraft(id, spec);
      throw error;
    }
    await this.clearDraft(id);
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteAgent(id);
    await this.clearDraft(id);
  }
}
