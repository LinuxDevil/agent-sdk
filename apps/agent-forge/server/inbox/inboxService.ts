/**
 * InboxService - everything that waits on the user across one
 * workspace's agents (PLAN §10, R02a): pending tool approvals and
 * `ask_question` pauses from RunManager's status, pending change drafts,
 * open prompt suggestions and undismissed alerts.
 *
 * One instance per WorkspaceContext (`createWorkspaceContext` builds and
 * `start()`s it; the app's `close()` `stop()`s it). `refresh()` recounts
 * and publishes `{ type: 'inbox.count', count }` on the workspace's event
 * bus only when the number changed; `start()` wires the triggers -
 * RunManager 'status' pushes, draft/suggestion/agent StudioEvents and
 * AlertStore changes - through a 250 ms debounce so a burst of writes
 * produces one recount.
 *
 * Alerts are Studio-global records stamped with a `workspaceId`; this
 * service lists only its own workspace's (`?ws=all` merging is W09a).
 */
import type { AgentRepo } from '../storage/agentRepo';
import type { DraftStore } from '../storage/draftStore';
import type { SuggestionStore } from '../storage/suggestionStore';
import type { FileApprovalStore } from '../approvalStore';
import type { RunManager } from '../runRegistry';
import type { AlertStore, InboxAlert } from './alertStore';
import type { StudioEventBus } from '../events/eventBus';
import type { AgentRunStatusPayload, InboxItem, StoredSuggestion } from '../../shared/wireTypes';

/** What {@link InboxService} reads; every member is the owning context's own store (the alert store is Studio-global, filtered by `workspaceId`). */
export interface InboxServiceDeps {
  repo: AgentRepo;
  runManager: RunManager;
  approvalStore: FileApprovalStore;
  drafts: DraftStore;
  suggestions: SuggestionStore;
  alerts: AlertStore;
  events: StudioEventBus;
  /** `WorkspaceRef.id` - the workspace this inbox lists (alerts are global and filtered on it). */
  workspaceId: string;
}

/** Trailing debounce for change notifications: one recount per burst. */
const REFRESH_DEBOUNCE_MS = 250;

/** The copy cap the ticket fixes for `title`/`detail` strings. */
const DETAIL_MAX_CHARS = 140;

function clip(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? text.slice(0, DETAIL_MAX_CHARS) : text;
}

/** `Omit` per union member - the plain form collapses a union to its common keys. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An item before `agentName` is resolved (the spec read happens once per agent that actually has items). */
export type UnnamedInboxItem = OmitEach<InboxItem, 'agentName'>;

/** The `expiresAt` sort key: only approval/question rows carry one; everything else sorts after them. */
function expiresAtOf(item: InboxItem): string | null {
  return item.kind === 'approval' || item.kind === 'question' ? item.expiresAt : null;
}

/** Contract order: soonest deadline first (no deadline last), then newest `at` first. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const ea = expiresAtOf(a);
  const eb = expiresAtOf(b);
  if (ea !== eb) {
    if (ea === null) return 1;
    if (eb === null) return -1;
    return ea.localeCompare(eb);
  }
  return b.at.localeCompare(a.at);
}

/**
 * The paused run's pending approval/question as an inbox row (at most one
 * per agent - RunManager keeps one run per agent). `expiresAt` comes from
 * the approval store's `PendingApproval` when the record is still there;
 * the status payload's `deadline` (the SDK expiry folded with the run's
 * own bound) is the fallback. A record the store no longer holds is
 * skipped once its deadline has passed - the pause is stale.
 */
async function approvalItem(
  deps: InboxServiceDeps,
  agentId: string,
  status: AgentRunStatusPayload
): Promise<UnnamedInboxItem[]> {
  const pending = status.pendingApproval;
  if (status.status !== 'paused' || pending === undefined) return [];
  const record = await deps.approvalStore.peek(agentId, pending.approvalId);
  const expiresAt = record?.pending.expiresAt ?? pending.deadline;
  if (record === null && expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return [];
  const base = {
    agentId,
    workspaceId: deps.workspaceId,
    at: pending.createdAt,
    expiresAt,
  };
  if (pending.kind === 'question') {
    const question = pending.question;
    return [
      {
        ...base,
        id: `question:${agentId}:${pending.approvalId}`,
        kind: 'question',
        approvalId: pending.approvalId,
        title: clip(question?.text ?? 'Question'),
        detail: null,
        question: question?.text ?? '',
        options: question?.options ?? [],
        allowFreeText: question?.allowFreeText ?? false,
      },
    ];
  }
  return [
    {
      ...base,
      id: `approval:${agentId}:${pending.approvalId}`,
      kind: 'approval',
      approvalId: pending.approvalId,
      title: `Approve ${pending.toolName}?`,
      detail: clip(JSON.stringify(pending.args)),
      toolName: pending.toolName,
      args: pending.args,
    },
  ];
}

/** The agent's pending draft as an inbox row, or none. */
async function draftItem(drafts: DraftStore, workspaceId: string, agentId: string): Promise<UnnamedInboxItem[]> {
  const draft = await drafts.current(agentId);
  if (draft === undefined || draft.status !== 'pending') return [];
  return [
    {
      id: `draft:${agentId}:${draft.id}`,
      kind: 'draft',
      agentId,
      workspaceId,
      at: draft.createdAt,
      title: 'Pending change',
      detail: clip(draft.reason),
      draftId: draft.id,
      origin: draft.origin,
      gated: (draft.classes?.gated.length ?? 0) > 0,
    },
  ];
}

/** The agent's open `prompt_edit` suggestions as inbox rows. */
async function suggestionItems(suggestions: SuggestionStore, workspaceId: string, agentId: string): Promise<UnnamedInboxItem[]> {
  const stored = await suggestions.list(agentId);
  const promptEdits = stored.filter((item): item is Extract<StoredSuggestion, { kind: 'prompt_edit' }> => item.kind === 'prompt_edit');
  return promptEdits
    .filter((item) => item.status === 'open')
    .map((item) => ({
      id: `suggestion:${agentId}:${item.id}`,
      kind: 'suggestion' as const,
      agentId,
      workspaceId,
      at: item.createdAt,
      title: 'Prompt suggestion',
      detail: clip(item.expectedSaving),
      suggestionId: item.id,
      confidence: item.confidence,
    }));
}

/** `spec.name` per agent that produced an item; agents whose spec is gone fall back to their id. */
export async function agentNamesOf(repo: AgentRepo, items: readonly UnnamedInboxItem[]): Promise<Map<string, string>> {
  const ids = [...new Set(items.map((item) => item.agentId))];
  const entries = await Promise.all(
    ids.map(async (id) => [id, (await repo.readSpec(id))?.name ?? id] as const)
  );
  return new Map(entries);
}

/** Names resolved + contract-sorted - the tail every item source shares. */
async function finishItems(repo: AgentRepo, unnamed: UnnamedInboxItem[]): Promise<InboxItem[]> {
  const names = await agentNamesOf(repo, unnamed);
  return unnamed
    .map((item) => ({ ...item, agentName: names.get(item.agentId) ?? item.agentId }) as InboxItem)
    .sort(compareInboxItems);
}

/**
 * Every pending draft across `repo`'s agents as named inbox rows (W09a):
 * the disk-only half of the inbox a cold workspace can answer without a
 * RunManager - `InboxService.list` and the `?ws=all` aggregate share it.
 */
export async function draftInboxItems(repo: AgentRepo, drafts: DraftStore, workspaceId: string): Promise<InboxItem[]> {
  const unnamed = (
    await Promise.all(repo.listIds().map((agentId) => draftItem(drafts, workspaceId, agentId)))
  ).flat();
  return finishItems(repo, unnamed);
}

/** Every open `prompt_edit` suggestion across `repo`'s agents, named and sorted like {@link draftInboxItems}. */
export async function suggestionInboxItems(repo: AgentRepo, suggestions: SuggestionStore, workspaceId: string): Promise<InboxItem[]> {
  const unnamed = (
    await Promise.all(repo.listIds().map((agentId) => suggestionItems(suggestions, workspaceId, agentId)))
  ).flat();
  return finishItems(repo, unnamed);
}

/** This workspace's undismissed alerts as inbox rows (the store is global; `list()` already drops dismissed). */
async function alertItems(deps: InboxServiceDeps): Promise<UnnamedInboxItem[]> {
  const alerts = await deps.alerts.list();
  return alerts
    .filter((alert) => alert.workspaceId === deps.workspaceId)
    .map((alert) => alertItem(deps.workspaceId, alert));
}

export function alertItem(workspaceId: string, alert: InboxAlert): UnnamedInboxItem {
  return {
    id: `alert:${alert.agentId}:${alert.id}`,
    kind: 'alert',
    agentId: alert.agentId,
    workspaceId,
    at: alert.createdAt,
    title: alert.title,
    detail: alert.detail,
    alertId: alert.id,
    alertKind: alert.kind,
    payload: alert.payload,
  };
}

export class InboxService {
  private lastCount: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: InboxServiceDeps) {}

  /** Every item waiting on the user, contract-sorted; `agentName` resolved from each item's spec (the id itself when the spec is gone). */
  async list(): Promise<InboxItem[]> {
    const agentIds = this.deps.repo.listIds();
    const approvals = (
      await Promise.all(
        agentIds.map(async (agentId) => approvalItem(this.deps, agentId, this.deps.runManager.status(agentId)))
      )
    ).flat();
    const [drafts, suggestions, alerts] = await Promise.all([
      draftInboxItems(this.deps.repo, this.deps.drafts, this.deps.workspaceId),
      suggestionInboxItems(this.deps.repo, this.deps.suggestions, this.deps.workspaceId),
      alertItems(this.deps),
    ]);
    const names = await agentNamesOf(this.deps.repo, [...approvals, ...alerts]);
    const named = [...approvals, ...alerts].map(
      (item) => ({ ...item, agentName: names.get(item.agentId) ?? item.agentId }) as InboxItem
    );
    return [...named, ...drafts, ...suggestions].sort(compareInboxItems);
  }

  /** `list().length` - what `inbox.count` publishes. */
  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** Recounts and publishes `inbox.count` on the workspace bus when it changed since the last publish. */
  async refresh(): Promise<void> {
    const count = await this.count();
    if (count === this.lastCount) return;
    this.lastCount = count;
    this.deps.events.publish({ type: 'inbox.count', count });
  }

  /**
   * Dismisses one of this workspace's alerts and refreshes the count.
   * `false` when the id is unknown, already dismissed, or belongs to a
   * different workspace (the alert store is global).
   */
  async dismissAlert(alertId: string): Promise<boolean> {
    const alerts = await this.deps.alerts.list({ includeDismissed: true });
    const target = alerts.find((alert) => alert.id === alertId);
    if (target === undefined || target.workspaceId !== this.deps.workspaceId || target.dismissedAt !== null) {
      return false;
    }
    await this.deps.alerts.dismiss(alertId);
    await this.refresh();
    return true;
  }

  /** Subscribes the recount triggers; idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const bump = () => this.scheduleRefresh();
    this.deps.runManager.on('status', bump);
    this.unsubscribers.push(
      () => this.deps.runManager.off('status', bump),
      this.deps.events.subscribe((event) => {
        if (event.type === 'draft.changed' || event.type === 'suggestion.new' || event.type === 'agent.changed') bump();
      }),
      this.deps.alerts.onChange(bump)
    );
  }

  /** Clears the pending recount and every subscription. */
  stop(): void {
    this.started = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /** Trailing-edge debounce: the last change in a burst wins the recount. */
  private scheduleRefresh(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => undefined);
    }, REFRESH_DEBOUNCE_MS);
    this.timer.unref?.();
  }
}
