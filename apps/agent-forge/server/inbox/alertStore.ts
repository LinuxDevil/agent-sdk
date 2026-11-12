/**
 * AlertStore - the Studio-global inbox alert list (PLAN §10, L12).
 *
 * One JSON array at `studioPaths().alerts` (`<home>/inbox/alerts.json`),
 * newest first, capped at 500 records. Every read-modify-write runs
 * inside `withAgentLock('__inbox__')` and writes through `writeJsonAtomic`,
 * so parallel `add()`s both land and a reader only ever sees a complete
 * file. `onChange` listeners fire after every add/dismiss - R02b's
 * `inbox.count` event and the Inbox UI subscribe here.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, withAgentLock, writeJsonAtomic } from '../storage/atomic';

/** The kinds of inbox alert Studio raises today; R02a/R02b/R05-R09 add producers, not kinds. */
export type AlertKind = 'auto_disabled' | 'publish_failed' | 'low_rating';

/** One inbox alert record as stored in `alerts.json`. */
export interface InboxAlert {
  id: string;
  kind: AlertKind;
  agentId: string;
  /** The workspace the alert's agent lives in (`WorkspaceRef.id`). */
  workspaceId: string;
  title: string;
  detail: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  dismissedAt: string | null;
}

/** What `add()` needs beyond the store-stamped id/timestamps. */
export type NewInboxAlert = Pick<InboxAlert, 'kind' | 'agentId' | 'workspaceId' | 'title' | 'detail' | 'payload'>;

/** The mutex key serializing every alerts read-modify-write (the `__` prefix keeps it off the agent-id namespace). */
const ALERTS_LOCK = '__inbox__';

/** The on-disk cap: the list is an alert feed, not an audit log. */
const MAX_ALERTS = 500;

export class AlertStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {}

  /** Appends an alert at the head of the list (newest first), trimming to {@link MAX_ALERTS}. */
  async add(input: NewInboxAlert): Promise<InboxAlert> {
    return withAgentLock(ALERTS_LOCK, async () => {
      const alerts = await this.readAll();
      const alert: InboxAlert = {
        id: `alert_${randomUUID()}`,
        kind: input.kind,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        title: input.title,
        detail: input.detail,
        payload: input.payload,
        createdAt: new Date().toISOString(),
        dismissedAt: null,
      };
      const next = [alert, ...alerts].slice(0, MAX_ALERTS);
      await this.writeAll(next);
      this.notify();
      return alert;
    });
  }

  /** The stored alerts, newest first; dismissed ones only with `includeDismissed`. */
  async list(options?: { includeDismissed?: boolean }): Promise<InboxAlert[]> {
    const alerts = await this.readAll();
    return options?.includeDismissed ? alerts : alerts.filter((alert) => alert.dismissedAt === null);
  }

  /** Stamps `dismissedAt` on one alert; `undefined` when the id is unknown. */
  async dismiss(id: string): Promise<InboxAlert | undefined> {
    return withAgentLock(ALERTS_LOCK, async () => {
      const alerts = await this.readAll();
      const index = alerts.findIndex((alert) => alert.id === id);
      if (index === -1) return undefined;
      const alert: InboxAlert = { ...alerts[index], dismissedAt: new Date().toISOString() };
      const next = [...alerts];
      next[index] = alert;
      await this.writeAll(next);
      this.notify();
      return alert;
    });
  }

  /** Subscribes to post-add/post-dismiss notifications; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async readAll(): Promise<InboxAlert[]> {
    return (await readJsonFile<InboxAlert[]>(this.file)) ?? [];
  }

  private async writeAll(alerts: InboxAlert[]): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, alerts);
  }
}
