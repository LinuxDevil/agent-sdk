/**
 * LOU-Y6: the child conversations behind `task` calls, kept by `taskId` so
 * the lead can resume or fork one. Saved in the lead's session store under a
 * key hashed from the lead session and the taskId (so ids never collide
 * across lead sessions), or in memory for one lead run.
 */

import type { Message } from '../providers';
import { SDKError } from '../execution/errors';
import type { SessionStore } from '../session/sessionStore';

/** How a `task` call starts its child: fresh, continuing a task, or from a copy of one. */
export type TaskMode = 'new' | 'resume' | 'fork';

/** A stored child conversation: its transcript (local) or its remote session (remote). */
export interface TaskRecord {
  messages: Message[];
  remoteSessionId?: string;
}

/** Name of the header message stored before a child's transcript. */
const HEADER = 'lousho-subagent-task';

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The store of a lead run without a session: a Map, for that run only. */
function runMemory(): SessionStore {
  const saved = new Map<string, Message[]>();
  return {
    load: async (id) => structuredClone(saved.get(id)),
    save: async (id, messages) => void saved.set(id, structuredClone([...messages])),
    delete: async (id) => void saved.delete(id),
  };
}

/** The error for a taskId this lead session has no conversation for. */
export function taskNotFound(message: string): SDKError {
  return new SDKError(message, 'LOUSHO_SUBAGENT_TASK_NOT_FOUND');
}

/** The child conversations of one lead session (or, without a session, of one lead run). */
export class TaskSessions {
  private counter = 0;
  private readonly running = new Set<string>();

  private constructor(
    private readonly store: SessionStore,
    private readonly scope: string
  ) {}

  /**
   * In `sessions` under the lead's session (a session turn's `<id>.turn-<n>`
   * counts as session `<id>`), else in memory for this run.
   */
  static of(sessions: SessionStore | undefined, leadSessionId: string | undefined): TaskSessions {
    if (!sessions || leadSessionId === undefined) return new TaskSessions(runMemory(), '');
    return new TaskSessions(sessions, leadSessionId.replace(/\.turn-\d+$/, ''));
  }

  /** A taskId not used yet in this lead session. */
  async allocate(): Promise<string> {
    for (;;) {
      const taskId = `task_${++this.counter}`;
      if (!(await this.store.load(await this.key(taskId)))) return taskId;
    }
  }

  /** The conversation of `taskId`; throws a coded error when it is unknown, another sub-agent's, or still running. */
  async load(taskId: string, agent: string): Promise<TaskRecord> {
    if (this.running.has(taskId)) throw busy(taskId);
    const [header, ...messages] = (await this.store.load(await this.key(taskId))) ?? [];
    if (header?.name !== HEADER) {
      throw taskNotFound(`Unknown taskId '${taskId}': no finished task of this lead session has that id (taskIds of other sessions or runs cannot be used). Omit taskId to start a new task.`);
    }
    const saved = JSON.parse(header.content as string) as { agent: string; remoteSessionId?: string };
    if (saved.agent !== agent) {
      throw taskNotFound(`taskId '${taskId}' belongs to sub-agent '${saved.agent}', not '${agent}'. Pass agent: '${saved.agent}' to continue it.`);
    }
    return { messages, remoteSessionId: saved.remoteSessionId };
  }

  async save(taskId: string, agent: string, record: TaskRecord): Promise<void> {
    const header: Message = { role: 'system', name: HEADER, content: JSON.stringify({ agent, remoteSessionId: record.remoteSessionId }) };
    await this.store.save(await this.key(taskId), [header, ...record.messages]);
  }

  /** Runs `fn` with `taskId` marked as running, so it cannot be resumed meanwhile. */
  async run<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    this.running.add(taskId);
    try {
      return await fn();
    } finally {
      this.running.delete(taskId);
    }
  }

  private async key(taskId: string): Promise<string> {
    return `subagent-task-${await sha256(`${this.scope}\n${taskId}`)}`;
  }
}

/** The error for a taskId whose child is still running (sync or in the background). */
export function busy(taskId: string): SDKError {
  return new SDKError(
    `Task '${taskId}' is still running. Wait for it with agent_await (or stop it with agent_cancel), then continue it.`,
    'LOUSHO_SUBAGENT_TASK_BUSY'
  );
}
