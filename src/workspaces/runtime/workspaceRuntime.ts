import type { Message } from '../../providers/llm';
import { SDKError } from '../../utils/sdkError';
import type { WireRunEvent } from '../client/wireTypes';
import type { EffectiveHarness } from '../contracts/compose';
import type { PageInput, PageResult, PageRunStatus, PageUsage } from '../contracts/execution';
import type { RevisionId, WorkspaceSource } from '../source/types';
import type { StartRun } from './stores';
import { artifactSink } from './artifacts';
import { finishStatus } from './engines/single';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { addUsage, EMPTY_USAGE, runPage } from './pageRuntime';
import { explainHarness, profileStoreFor, resolvePageHarness } from './resolveHarness';
import { limiter, openWorkspaceSession, resultText, type PageRunRecord, type WorkspaceSessionContext, type WorkspaceTurn } from './router';
import { eventChannel, runRecorder, type EventChannel, type RunRecorder } from './runEvents';
import { checkHost, pageHostOf, type WorkspaceHost } from './workspaceHost';

/** The workspace run began, pinned to one revision. */
export interface WorkspaceRunStartedEvent {
  /** Discriminant. */
  type: 'started';
  /** The workspace run's id. */
  runId: string;
  /** The thread the run continues. */
  threadId: string;
  /** The revision every file of the run is read at. */
  revision: RevisionId;
}

/** One event of a page run made during the workspace run, with its id in that page run's log. */
export interface WorkspacePageEvent extends WireRunEvent {
  /** Discriminant. */
  type: 'page';
}

/** One page run's share of a workspace run. */
export interface WorkspacePageUsage {
  /** The page run's id. */
  runId: string;
  /** The page that ran. */
  pageId: string;
  /** How the page run ended. */
  status: PageRunStatus;
  /** What the page run used. */
  usage: PageUsage;
}

/** The workspace run ended; `usage` is the main agent's own use plus every page run's. */
export interface WorkspaceRunFinishedEvent {
  /** Discriminant. */
  type: 'finished';
  /** The workspace run's id. */
  runId: string;
  /** How the run ended. */
  status: PageRunStatus;
  /** The rolled-up usage of the run. */
  usage: PageUsage;
  /** Each page run's usage, in the order they ran. */
  pages: WorkspacePageUsage[];
  /** The turn's outcome. */
  turn: WorkspaceTurn;
}

/** Every event of a workspace run, discriminated by `type`. */
export type WorkspaceRunEvent = WorkspaceRunStartedEvent | WorkspacePageEvent | WorkspaceRunFinishedEvent;

/** Options of {@link WorkspaceRuntime.run}. */
export interface WorkspaceRuntimeRunOptions {
  /** The thread the message belongs to; the main agent's transcript is kept under it in `stores.threads`. */
  threadId: string;
  /** Runs this page directly instead of going through the main agent; required when `mainAgent` is `null`. */
  pageId?: string;
  /** Structured inputs for `pageId`. */
  inputs?: unknown;
  /** Aborts the run. */
  signal?: AbortSignal;
  /** The workspace run's id; defaults to a new one. */
  runId?: string;
}

/** Options of {@link WorkspaceRuntime.runPage}. */
export interface RunPageOptions {
  /** Aborts the run. */
  signal?: AbortSignal;
  /** The page run's id; defaults to a new one. */
  runId?: string;
  /** The workspace thread to record the run in as a note, so the main agent can follow up on it. */
  threadId?: string;
  /** Receives each event once it is in the run's log, with its id. */
  onEvent?: (event: WireRunEvent) => void;
}

/** What {@link WorkspaceRuntime.explain} returns for one page. */
export interface PageExplanation {
  /** The page. */
  pageId: string;
  /** The revision the page was read at. */
  revision: RevisionId;
  /** The effective harness's hash. */
  hash: string;
  /** The effective harness. */
  harness: EffectiveHarness;
  /** Which layer set each field, for people. */
  text: string;
}

/** A workspace bound to its host: the one entry point for the service, the CLI, Forge and tests. */
export interface WorkspaceRuntime {
  /** Sends `message` on a thread, to the main agent or to `options.pageId`, and streams the run's events; ends with `finished`. Leaving the stream early cancels the run. A `runId` that is already active throws `LOUSHO_WORKSPACE_RUN_ACTIVE`. */
  run(message: string, options: WorkspaceRuntimeRunOptions): AsyncIterable<WorkspaceRunEvent>;
  /** Runs one page directly (D18); with `options.threadId` the run is also noted in that thread. A `runId` that is already active throws `LOUSHO_WORKSPACE_RUN_ACTIVE`. */
  runPage(pageId: string, input: Omit<PageInput, 'pageId'> & Partial<Pick<PageInput, 'pageId'>>, options?: RunPageOptions): Promise<PageResult>;
  /** Aborts a running or queued workspace or page run; `false` when no such run is active. */
  cancel(runId: string): boolean;
  /** The effective harness of a page at the current revision. */
  explain(pageId: string): Promise<PageExplanation>;
  /** Cancels every active run, waits for them, and refuses new ones. */
  close(): Promise<void>;
}

interface ThreadState {
  tail: Promise<unknown>;
  busy: number;
  runs: PageRunRecord[];
}

const KEPT_REVISIONS = 4;

const KEPT_THREADS = 256;

function activeError(runId: string): SDKError {
  return new SDKError(`Run '${runId}' is already active in this runtime; pass a new runId.`, 'LOUSHO_WORKSPACE_RUN_ACTIVE');
}

function closedError(): SDKError {
  return new SDKError('This workspace runtime is closed.', 'LOUSHO_WORKSPACE_RUNTIME_CLOSED');
}

function turnStatus(turn: WorkspaceTurn, signal: AbortSignal): PageRunStatus {
  if (signal.aborted) return 'cancelled';
  if (turn.kind === 'error') return 'failed';
  return turn.kind === 'page' ? turn.record.result.status : finishStatus(turn.finishReason);
}

function turnRuns(turn: WorkspaceTurn): PageRunRecord[] {
  if (turn.kind === 'main') return turn.runs;
  return turn.kind === 'page' ? [turn.record] : [];
}

function finishedEvent(runId: string, turn: WorkspaceTurn, signal: AbortSignal): WorkspaceRunFinishedEvent {
  const runs = turnRuns(turn);
  const own = turn.kind === 'main' ? turn.usage : EMPTY_USAGE;
  const usage = runs.reduce((total, record) => addUsage(total, record.result.usage), own);
  const pages = runs.map((record) => ({ runId: record.runId, pageId: record.pageId, status: record.result.status, usage: record.result.usage }));
  return { type: 'finished', runId, status: turnStatus(turn, signal), usage, pages, turn };
}

function noteOf(record: PageRunRecord): Message {
  return { role: 'user', content: `[note] A person ran a page directly, outside this conversation.\n${resultText(record)}` };
}

/** Builds the runtime for one workspace source with everything environmental injected by the host; a missing dependency fails here, naming the field. Each run loads one revision of the source and keeps it to the end; its run rows carry that revision. */
export function createWorkspaceRuntime(source: WorkspaceSource, host: WorkspaceHost): WorkspaceRuntime {
  const checked = checkHost(host);
  const { stores } = checked;
  const pageHost = pageHostOf(checked);
  const newRunId = checked.newRunId ?? (() => globalThis.crypto.randomUUID());
  const gate = limiter(checked.limits?.maxConcurrentRuns ?? Number.POSITIVE_INFINITY);
  const active = new Map<string, AbortController>();
  const inflight = new Set<Promise<unknown>>();
  const loaded = new Map<RevisionId, Promise<LoadedWorkspace>>();
  const threads = new Map<string, ThreadState>();
  const state = { closed: false };

  function ensureOpen(): void {
    if (state.closed) throw closedError();
  }

  function track<T>(work: Promise<T>): Promise<T> {
    inflight.add(work);
    const settle = (): void => {
      inflight.delete(work);
    };
    work.then(settle, settle);
    return work;
  }

  function claim(runId: string): void {
    if (active.has(runId)) throw activeError(runId);
  }

  function register(runId: string, signal: AbortSignal | undefined): AbortSignal {
    claim(runId);
    const controller = new AbortController();
    active.set(runId, controller);
    return signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }

  async function load(): Promise<LoadedWorkspace> {
    const revision = await source.revision();
    const cached = loaded.get(revision);
    if (cached) return cached;
    const next = loadWorkspace(source, { revision, mode: 'default' });
    loaded.set(revision, next);
    next.catch(() => loaded.delete(revision));
    while (loaded.size > KEPT_REVISIONS) loaded.delete(loaded.keys().next().value as RevisionId);
    return next;
  }

  function evictSettledThreads(keep: string): void {
    for (const [id, entry] of threads) {
      if (threads.size <= KEPT_THREADS) return;
      if (entry.busy === 0 && id !== keep) threads.delete(id);
    }
  }

  function thread(threadId: string): ThreadState {
    const existing = threads.get(threadId);
    if (existing) {
      threads.delete(threadId);
      threads.set(threadId, existing);
      return existing;
    }
    const made: ThreadState = { tail: Promise.resolve(), busy: 0, runs: [] };
    threads.set(threadId, made);
    evictSettledThreads(threadId);
    return made;
  }

  function onThread<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const entry = thread(threadId);
    entry.busy += 1;
    const next = entry.tail.then(task, task);
    entry.tail = next.catch(() => undefined);
    const done = (): void => {
      entry.busy -= 1;
    };
    next.then(done, done);
    return next;
  }

  async function beginPage(runId: string, row: Omit<StartRun, 'runId'>, recorders: Map<string, RunRecorder>, listener: ((event: WireRunEvent) => void) | undefined): Promise<RunRecorder> {
    await stores.runs.start({ runId, ...row });
    const recorder = runRecorder(runId, stores.events, listener);
    recorders.set(runId, recorder);
    return recorder;
  }

  async function endRun(runId: string, status: PageRunStatus, recorder: RunRecorder | undefined): Promise<void> {
    active.delete(runId);
    await recorder?.flush();
    await stores.runs.finish(runId, status);
  }

  function failedStatus(signal: AbortSignal): PageRunStatus {
    return signal.aborted ? 'cancelled' : 'failed';
  }

  function sessionContext(workspace: LoadedWorkspace, parentRunId: string, threadId: string, runSignal: AbortSignal, channel: EventChannel<WorkspaceRunEvent>): WorkspaceSessionContext {
    const recorders = new Map<string, RunRecorder>();
    const push = (wire: WireRunEvent): void => channel.push({ type: 'page', ...wire });
    return {
      host: pageHost,
      artifacts: (runId) => artifactSink(stores.artifacts, { workspace: workspace.manifest.id, runId }),
      newRunId,
      sessionId: threadId,
      parentRunId,
      threads: stores.threads,
      priorRuns: thread(threadId).runs,
      emit: (runId, event) => recorders.get(runId)?.emit(event),
      pageRuns: {
        async start(runId, pageId, signal) {
          claim(runId);
          await beginPage(runId, { pageId, revision: workspace.revision, threadId, parentRunId }, recorders, push);
          return register(runId, signal ?? runSignal);
        },
        end: (runId, result) => endRun(runId, result?.status ?? failedStatus(runSignal), recorders.get(runId)),
      },
      mode: 'default',
      ...(checked.engines && { engines: checked.engines }),
    };
  }

  async function turnOf(workspace: LoadedWorkspace, runId: string, message: string, options: WorkspaceRuntimeRunOptions, signal: AbortSignal, channel: EventChannel<WorkspaceRunEvent>): Promise<WorkspaceTurn> {
    const session = openWorkspaceSession(workspace, sessionContext(workspace, runId, options.threadId, signal, channel));
    const turn = await session.run(message, { signal, ...(options.pageId !== undefined && { pageId: options.pageId }), ...(options.inputs !== undefined && { inputs: options.inputs }) });
    thread(options.threadId).runs = [...session.runs()];
    return turn;
  }

  async function workspaceRun(runId: string, message: string, options: WorkspaceRuntimeRunOptions, signal: AbortSignal, channel: EventChannel<WorkspaceRunEvent>): Promise<void> {
    const workspace = await load();
    await stores.runs.start({ runId, pageId: '', revision: workspace.revision, threadId: options.threadId });
    const recorder = runRecorder(runId, stores.events, undefined);
    channel.push({ type: 'started', runId, threadId: options.threadId, revision: workspace.revision });
    try {
      const finished = finishedEvent(runId, await turnOf(workspace, runId, message, options, signal, channel), signal);
      recorder.emit({ type: 'finished', status: finished.status, usage: finished.usage });
      await endRun(runId, finished.status, recorder);
      channel.push(finished);
    } catch (error) {
      recorder.emit({ type: 'finished', status: failedStatus(signal) });
      await endRun(runId, failedStatus(signal), recorder);
      throw error;
    }
  }

  async function notePage(threadId: string, record: PageRunRecord): Promise<void> {
    await onThread(threadId, async () => {
      const messages = (await stores.threads.load(threadId)) ?? [];
      await stores.threads.save(threadId, [...messages, noteOf(record)]);
    });
    thread(threadId).runs.push(record);
  }

  async function directPage(runId: string, input: PageInput, options: RunPageOptions, signal: AbortSignal): Promise<PageResult> {
    const workspace = await load();
    const row = { pageId: input.pageId, revision: workspace.revision, ...(options.threadId !== undefined && { threadId: options.threadId }) };
    const recorder = await beginPage(runId, row, new Map(), options.onEvent);
    const prior = options.threadId === undefined ? undefined : thread(options.threadId).runs.find((record) => record.runId === input.revise?.runId)?.result;
    let result: PageResult | undefined;
    try {
      result = await runPage(workspace, input, {
        host: pageHost,
        runId,
        artifacts: artifactSink(stores.artifacts, { workspace: workspace.manifest.id, runId }),
        signal,
        emit: (event) => recorder.emit(event),
        mode: 'default',
        ...(prior && { prior }),
        ...(checked.engines && { engines: checked.engines }),
      });
    } finally {
      await endRun(runId, result?.status ?? failedStatus(signal), recorder);
    }
    if (options.threadId !== undefined) await notePage(options.threadId, { runId, pageId: input.pageId, task: input.task, ...(input.inputs !== undefined && { inputs: input.inputs }), ...(input.revise && { revises: input.revise.runId }), result });
    return result;
  }

  return {
    run(message, options) {
      ensureOpen();
      const runId = options.runId ?? newRunId();
      const signal = register(runId, options.signal);
      const channel = eventChannel<WorkspaceRunEvent>(() => active.get(runId)?.abort('cancelled'));
      const work = onThread(options.threadId, () => gate(() => workspaceRun(runId, message, options, signal, channel)));
      track(work).then(
        () => channel.end(),
        (error: unknown) => {
          active.delete(runId);
          channel.fail(error);
        }
      );
      return channel.items;
    },
    runPage(pageId, input, options = {}) {
      ensureOpen();
      const runId = options.runId ?? newRunId();
      const signal = register(runId, options.signal);
      const work = gate(() => directPage(runId, { ...input, pageId }, options, signal)).finally(() => active.delete(runId));
      return track(work);
    },
    cancel(runId) {
      const controller = active.get(runId);
      if (!controller) return false;
      controller.abort('cancelled');
      return true;
    },
    async explain(pageId) {
      ensureOpen();
      const workspace = await load();
      const harness = resolvePageHarness(workspace, pageId, profileStoreFor(workspace, checked.globals.profiles));
      return { pageId, revision: workspace.revision, hash: harness.hash, harness, text: explainHarness(harness) };
    },
    async close() {
      state.closed = true;
      for (const controller of active.values()) controller.abort('closed');
      await Promise.allSettled([...inflight]);
      loaded.clear();
      threads.clear();
    },
  };
}
