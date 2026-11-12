import type { AgentSpecV2 } from 'lousho';
import type { AgentListItem, AgentRecord, CanvasLayout } from '../../shared/wireTypes';
import type { AgentStore } from './AgentStore';

/** The slice of `RuntimeClient` this store needs (injectable for tests). */
export interface AgentApi {
  listAgents(): Promise<AgentListItem[]>;
  loadAgent(id: string): Promise<AgentRecord | undefined>;
  saveAgent(id: string, spec: AgentSpecV2): Promise<void>;
  saveLayout(id: string, layout: CanvasLayout): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  workspace(): Promise<{ baseDir: string }>;
}

const DRAFT_PREFIX = 'agent-forge:draft:';

/**
 * The offline draft cache entry: the `{ spec, layout }` pair of pending
 * writes that never reached the server. Either field may be absent (a
 * spec-only save or a layout-only move), which is why they are separate
 * optional slots rather than one record.
 */
interface Draft {
  spec?: AgentSpecV2;
  layout?: CanvasLayout;
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

/** The `CanvasLayout` a draft resolves to when neither the server nor the draft has one yet. */
const EMPTY_LAYOUT: CanvasLayout = { schemaVersion: 1, nodes: {}, notes: [] };

/** Nothing is published on a record the server never answered for. */
const UNPUBLISHED: AgentRecord['publishState'] = { version: null, matchesWorkingCopy: false, publishedAt: null };

/** The record `load` answers: the server copy with any unsent draft fields winning. */
function mergedRecord(id: string, draft: Draft, record: AgentRecord | undefined): AgentRecord | undefined {
  if (record === undefined && draft.spec === undefined) return undefined;
  return {
    id,
    spec: draft.spec ?? (record as AgentRecord).spec,
    meta: record?.meta ?? {
      schemaVersion: 1,
      enabled: false,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
      createdAt: '',
      updatedAt: '',
    },
    layout: draft.layout ?? record?.layout ?? EMPTY_LAYOUT,
    updatedAt: record?.updatedAt ?? '',
    latestVersion: record?.latestVersion ?? null,
    publishState: record?.publishState ?? UNPUBLISHED,
  };
}

/**
 * The studio's `AgentStore`, backed by the server's
 * `GET/PUT/DELETE /agents` and `PUT /agents/:id/layout`
 * (`.lousho/agents/` in the directory `lousho studio` was started in).
 *
 * `localStorage` is only a draft cache: a save that can't reach the server
 * is kept under a key that includes the server's workspace directory, and is
 * pushed (or, if the server is still down, returned) on the next load of
 * that agent - so unsaved edits survive a restart without leaking into
 * another project's studio. The draft now carries `{ spec, layout }`, so a
 * layout-only drag caches exactly like a spec edit.
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

  /** Merges `patch` into the agent's cached draft (a layout save never clobbers a pending spec, and vice versa). */
  private async writeDraft(id: string, patch: { spec?: AgentSpecV2; layout?: CanvasLayout }): Promise<void> {
    if (!this.storage) return;
    try {
      const existing = (await this.readDraft(id)) ?? { savedAt: '' };
      const draft: Draft = { ...existing, ...patch, savedAt: new Date().toISOString() };
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

  /** Drops one slot of the draft after its push succeeds, keeping the other if it is still pending. */
  private async clearDraftField(id: string, field: 'spec' | 'layout'): Promise<void> {
    if (!this.storage) return;
    const draft = await this.readDraft(id);
    if (draft === undefined) return;
    const remaining: Draft = { ...draft };
    delete remaining[field];
    if (remaining.spec === undefined && remaining.layout === undefined) {
      await this.clearDraft(id);
      return;
    }
    try {
      this.storage.setItem(await this.draftKey(id), JSON.stringify(remaining));
    } catch {
      // Same as writeDraft.
    }
  }

  list(): Promise<AgentListItem[]> {
    // Learn the workspace while the server is up, so a later offline save
    // still has a key to cache its draft under.
    this.draftKey('').catch(() => {});
    return this.api.listAgents();
  }

  async load(id: string): Promise<AgentRecord | undefined> {
    const draft = await this.readDraft(id);
    const record = await this.api.loadAgent(id).catch(() => undefined);
    if (draft === undefined || (draft.spec === undefined && draft.layout === undefined)) {
      return record;
    }
    // An edit that never reached the server: push it now, or keep showing it.
    try {
      if (draft.spec !== undefined) await this.api.saveAgent(id, draft.spec);
      if (draft.layout !== undefined) await this.api.saveLayout(id, draft.layout);
      await this.clearDraft(id);
    } catch {
      // Still offline - the draft stays cached and wins over the server copy.
    }
    return mergedRecord(id, draft, record);
  }

  async save(id: string, spec: AgentSpecV2): Promise<void> {
    try {
      await this.api.saveAgent(id, spec);
    } catch (error) {
      // Only an unreachable server makes a draft; a rejected spec (an API
      // error with a status) would just fail again on every load.
      if (!isApiError(error)) await this.writeDraft(id, { spec });
      throw error;
    }
    await this.clearDraftField(id, 'spec');
  }

  async saveLayout(id: string, layout: CanvasLayout): Promise<void> {
    try {
      await this.api.saveLayout(id, layout);
    } catch (error) {
      if (!isApiError(error)) await this.writeDraft(id, { layout });
      throw error;
    }
    await this.clearDraftField(id, 'layout');
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteAgent(id);
    await this.clearDraft(id);
  }
}
