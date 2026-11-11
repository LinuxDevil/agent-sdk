import { SDKError } from '../../execution/errors';
import type { Checkpoint, CheckpointListEntry, CheckpointListOptions, CheckpointStore } from '../../execution/checkpoint';
import type { Message } from '../../providers/llm';
import type { AgentStore } from '../../storage/agentStore';
import type { SessionStore } from '../../session/sessionStore';
import { isTerminalStatus, type PageRunEvent, type PageRunStatus } from '../contracts/execution';
import type { WireRunEvent } from '../client/wireTypes';

/** The project and workspace every key of a store view carries. */
export interface WorkspaceScope {
  /** The project that owns the workspace. */
  projectId: string;
  /** The workspace the view is bound to. */
  workspaceId: string;
}

/** A run's state: a page status, `running` while it executes, `interrupted` once a restart found it unfinished. */
export type RunState = PageRunStatus | 'running' | 'interrupted';

/** One run's row. */
export interface RunRecord extends WorkspaceScope {
  /** The run id. */
  runId: string;
  /** The page that ran. */
  pageId: string;
  /** The workspace revision the run is pinned to. */
  revision: string;
  /** Where the run stands. */
  status: RunState;
  /** Epoch milliseconds when the run started. */
  startedAt: number;
  /** Epoch milliseconds when the run ended; absent while it runs or waits for approval. */
  endedAt?: number;
}

/** What `runs.start` needs. */
export interface StartRun {
  /** The run id. */
  runId: string;
  /** The page to run. */
  pageId: string;
  /** The workspace revision the run is pinned to. */
  revision: string;
}

/** One stored event. */
export interface LedgerEvent {
  /** Its per-run sequence number, from 0. */
  id: number;
  /** The engine event. */
  event: PageRunEvent;
}

/** The unscoped run and event tables a backend implements; the stores bind them to one workspace. */
export interface RunLedger {
  /** Inserts a new run row; rejects when the run id exists. */
  insertRun(record: RunRecord): Promise<void>;
  /** Sets a run's status and end time. */
  updateRun(runId: string, status: RunState, endedAt: number | undefined): Promise<void>;
  /** One run row. */
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** The runs of one workspace, oldest first, optionally only those in the given states. */
  listRuns(scope: WorkspaceScope, states?: readonly RunState[]): Promise<RunRecord[]>;
  /** Appends an event and returns its per-run sequence number, from 0. */
  appendEvent(runId: string, event: PageRunEvent): Promise<number>;
  /** The events of a run with a sequence number above `afterId` (all of them when absent), in order. */
  readEvents(runId: string, afterId?: number): Promise<LedgerEvent[]>;
}

/** Transcripts of a workspace's threads. */
export interface WorkspaceThreadStore {
  /** The saved transcript of a thread, or `undefined`. */
  load(threadId: string): Promise<Message[] | undefined>;
  /** Replaces a thread's transcript. */
  save(threadId: string, messages: readonly Message[]): Promise<void>;
  /** Removes a thread's transcript. */
  delete(threadId: string): Promise<void>;
}

/** Checkpoints of a workspace's runs. */
export interface WorkspaceCheckpointStore {
  /** Saves the latest checkpoint of a run. */
  save(runId: string, checkpoint: Checkpoint): Promise<void>;
  /** The latest checkpoint of a run, or `null`. */
  load(runId: string): Promise<Checkpoint | null>;
  /** Deletes a run's checkpoint. */
  delete(runId: string): Promise<void>;
  /** The workspace's checkpoints, by run id, optionally only those with a status. */
  list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]>;
}

/** A workspace's run rows. */
export interface WorkspaceRunStore {
  /** Records a run as `running`. */
  start(run: StartRun): Promise<RunRecord>;
  /** Records the status a run ended (or paused) with. */
  finish(runId: string, status: PageRunStatus): Promise<RunRecord>;
  /** One run of this workspace, or `undefined`. */
  get(runId: string): Promise<RunRecord | undefined>;
  /** This workspace's runs, oldest first, optionally only those in the given states. */
  list(states?: readonly RunState[]): Promise<RunRecord[]>;
  /** Marks every run still `running` as `interrupted` (call once after a restart) and returns them. */
  markInterrupted(): Promise<RunRecord[]>;
}

/** A run's event log: ids are per run, rise by one and survive restarts. */
export interface WorkspaceRunEvents {
  /** Appends an event to a run's log and returns it with its id. */
  append(runId: string, event: PageRunEvent): Promise<WireRunEvent>;
  /** The events after `lastEventId` (the `Last-Event-ID` of a reconnect), or all of them. */
  read(runId: string, lastEventId?: number): Promise<WireRunEvent[]>;
}

/** The stores a host gives one workspace. */
export interface WorkspaceStores {
  /** Thread transcripts. */
  threads: WorkspaceThreadStore;
  /** Run rows. */
  runs: WorkspaceRunStore;
  /** Run checkpoints. */
  checkpoints: WorkspaceCheckpointStore;
  /** Run event logs. */
  events: WorkspaceRunEvents;
}

/** What a backend gives {@link createWorkspaceStores}. */
export interface HostBackend {
  /** Sessions and checkpoints. */
  agent: Pick<AgentStore, 'sessions' | 'checkpoints'>;
  /** Run rows and event logs. */
  ledger: RunLedger;
}

const PART = /^[A-Za-z0-9-]{1,40}$/;

function part(value: string, what: string): string {
  if (!PART.test(value)) {
    throw new SDKError(`Invalid ${what} ${JSON.stringify(value)}: 1-40 characters from A-Z, a-z, 0-9 and '-'.`, 'LOUSHO_CONFIG_INVALID');
  }
  return value;
}

function prefixOf(scope: WorkspaceScope): string {
  return `${part(scope.projectId, 'project id')}_${part(scope.workspaceId, 'workspace id')}_`;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new SDKError(`The store has no ${what}.`, 'LOUSHO_CONFIG_INVALID');
  return value;
}

function threadView(sessions: SessionStore, scope: WorkspaceScope): WorkspaceThreadStore {
  const prefix = prefixOf(scope);
  const key = (id: string): string => prefix + part(id, 'thread id');
  return {
    load: async (id) => sessions.load(key(id)),
    save: async (id, messages) => sessions.save(key(id), messages),
    delete: async (id) => sessions.delete(key(id)),
  };
}

function checkpointView(store: CheckpointStore, scope: WorkspaceScope): WorkspaceCheckpointStore {
  const prefix = prefixOf(scope);
  const key = (id: string): string => prefix + part(id, 'run id');
  return {
    save: async (id, checkpoint) => store.save(key(id), checkpoint),
    load: async (id) => store.load(key(id)),
    delete: async (id) => store.delete(key(id)),
    async list(options) {
      const entries = await required(store.list, 'checkpoint listing').call(store, options);
      return entries.filter((entry) => entry.sessionId.startsWith(prefix)).map((entry) => ({ ...entry, sessionId: entry.sessionId.slice(prefix.length) }));
    },
  };
}

function runView(ledger: RunLedger, scope: WorkspaceScope): WorkspaceRunStore {
  prefixOf(scope);
  const get = async (runId: string): Promise<RunRecord | undefined> => {
    const row = await ledger.getRun(part(runId, 'run id'));
    return row?.projectId === scope.projectId && row.workspaceId === scope.workspaceId ? row : undefined;
  };
  const settle = async (runId: string, status: RunState, endedAt: number | undefined): Promise<RunRecord> => {
    const row = required(await get(runId), `run ${runId}`);
    await ledger.updateRun(runId, status, endedAt);
    return { ...row, status, endedAt };
  };
  return {
    async start(run) {
      const record: RunRecord = { ...scope, runId: part(run.runId, 'run id'), pageId: run.pageId, revision: run.revision, status: 'running', startedAt: Date.now() };
      await ledger.insertRun(record);
      return record;
    },
    finish: (runId, status) => settle(runId, status, isTerminalStatus(status) ? Date.now() : undefined),
    get,
    list: (states) => ledger.listRuns(scope, states),
    async markInterrupted() {
      const running = await ledger.listRuns(scope, ['running']);
      const endedAt = Date.now();
      for (const run of running) await ledger.updateRun(run.runId, 'interrupted', endedAt);
      return running.map((run) => ({ ...run, status: 'interrupted' as const, endedAt }));
    },
  };
}

function eventView(ledger: RunLedger, runs: WorkspaceRunStore): WorkspaceRunEvents {
  const owned = async (runId: string): Promise<void> => {
    required(await runs.get(runId), `run ${runId}`);
  };
  return {
    async append(runId, event) {
      await owned(runId);
      return { id: await ledger.appendEvent(runId, event), runId, event };
    },
    async read(runId, lastEventId) {
      await owned(runId);
      const rows = await ledger.readEvents(runId, lastEventId);
      return rows.map((row) => ({ id: row.id, runId, event: row.event }));
    },
  };
}

/** Binds a backend's sessions, checkpoints and run ledger to one project and workspace, with both ids in every key. */
export function createWorkspaceStores(backend: HostBackend, scope: WorkspaceScope): WorkspaceStores {
  const runs = runView(backend.ledger, scope);
  return {
    threads: threadView(required(backend.agent.sessions, 'session store'), scope),
    checkpoints: checkpointView(required(backend.agent.checkpoints, 'checkpoint store'), scope),
    runs,
    events: eventView(backend.ledger, runs),
  };
}
