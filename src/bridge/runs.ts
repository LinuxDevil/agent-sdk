/**
 * `BridgeRuns`: the run half of the bridge protocol (W10b). One
 * {@link BridgeRunRecord} per `run`/`chat` request lives from `start`
 * until its segment settles with a `finishReason` other than
 * `'awaiting-approval'`, fails, or `abort` discards the pause; a paused
 * record continues through `resolveApproval`/`answerQuestion`, each of
 * which starts a new segment on a rebuilt agent (the approval store is
 * shared through the project `.lousho/agents/<agentId>` file store, so
 * the pause survives the rebuild).
 *
 * Ordering contract (Studio relies on it): the `run`/`chat`/
 * `resolveApproval`/`answerQuestion` response is written before any push
 * of that segment. `record.ready` is false while the handler runs; every
 * push of the segment queues on `record.queue` until `markReady(runId)`
 * (called by server.ts right after it wrote the response) flushes it in
 * order. A handler that fails drops its queue.
 */
import { randomUUID } from 'node:crypto';
import { createAgent, type CreateAgentConfig, type SimpleAgent } from '../createAgent';
import type { AgentInput } from '../providers/content';
import type { AgentRun } from '../execution/agentRun';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { PendingApproval } from '../execution/ApprovalGate';
import type { TraceExporter } from '../execution/tracing';
import { SDKError } from '../execution/errors';
import { parseAgentSpecV2 } from '../spec/v2/parse';
import { compileSpecWithNodeIds } from '../spec/v2/specToAgent';
import type { AgentSpecV2 } from '../spec/v2/types';
import { BridgeError, toBridgeErrorInfo } from './bridgeError';
import {
  MAX_LINE_BYTES,
  type BridgeParams,
  type BridgePush,
  type BridgePushData,
  type BridgePushEvent,
  type BridgeResults,
  type BridgeRunResult,
  type BridgeRunStarted,
} from './protocol';
import { applyEnv, bridgeSpecHost } from './specHost';
import { toWireJson } from './wireJson';

/** A segment in flight: the run handle and the controller `abort`/`abortAll` fire. */
interface LiveSegment {
  run: AgentRun;
  controller: AbortController;
}

/** One bridge run: its params (kept for rebuilding on resume), live segment, pause state and push queue. */
interface BridgeRunRecord {
  /** The id pushes and later methods refer to. */
  runId: string;
  /** The `run`/`chat` params, kept for rebuilding the agent on a continuation. */
  params: BridgeParams['run'] | BridgeParams['chat'];
  /** The parsed spec, validated once at `start`. */
  spec: AgentSpecV2;
  /** The agent of the latest segment; closed when the record is dropped or rebuilt. */
  agent?: SimpleAgent;
  /** Set while a segment runs; cleared when its `result` settles. */
  live?: LiveSegment;
  /** The approvals a paused run waits on (`[]` while live or settled-final). */
  pausedApprovalIds: string[];
  /** `false` while a `run`/`chat`/continuation handler runs; pushes queue until `markReady`. */
  ready: boolean;
  /** Pushes held while `ready` is false, flushed in order by `markReady`. */
  queue: BridgePush[];
  /** Resolves once the live segment's settle/fail (and its pushes) completed; `abortAll` waits on it. */
  settled?: Promise<void>;
}

/** The `run`/`chat`/`resolveApproval`/`answerQuestion` params a record rebuilds from. */
type RunParams = BridgeParams['run'] | BridgeParams['chat'];

const NOT_FOUND = (runId: string) => new BridgeError('LOUSHO_BRIDGE_RUN_NOT_FOUND', `No run '${runId}'.`);

/**
 * The bridge's run registry. `push` is server.ts's stdout writer; pushes
 * are `BridgePush` lines (no `id`). Construct one per `serveBridge`
 * session and register `abortAll` with `onShutdown`.
 */
export class BridgeRuns {
  private readonly records = new Map<string, BridgeRunRecord>();

  constructor(
    private readonly root: string,
    private readonly push: (message: BridgePush) => void
  ) {}

  /**
   * `run`/`chat`: validate the spec (flows are refused), build the agent,
   * start the segment and register the record. Resolves once the segment
   * is live — the response then precedes every push via `markReady`.
   */
  async start(method: 'run' | 'chat', params: RunParams): Promise<BridgeRunStarted> {
    const spec = parseAgentSpecV2(params.spec);
    if (spec.flow !== undefined) {
      throw new SDKError('Flow runs are not supported over the bridge yet.', 'LOUSHO_HOST_UNSUPPORTED');
    }
    const record: BridgeRunRecord = {
      runId: randomUUID(),
      params,
      spec,
      pausedApprovalIds: [],
      ready: false,
      queue: [],
    };
    const agent = await this.build(record);
    const controller = new AbortController();
    const input: AgentInput = method === 'run' ? (params as BridgeParams['run']).input : (params as BridgeParams['chat']).messages;
    const run = agent.stream(input, { sessionId: params.sessionId, signal: controller.signal });
    record.agent = agent;
    record.live = { run, controller };
    this.records.set(record.runId, record);
    this.watch(record);
    return { runId: record.runId, modelLabel: spec.model };
  }

  /** `steer`: queues or applies `message` on the live segment; `joined` arrives as a `steer.joined` push. */
  steer(p: BridgeParams['steer']): BridgeResults['steer'] {
    const record = this.records.get(p.runId);
    if (record === undefined) throw NOT_FOUND(p.runId);
    const live = record.live;
    if (live === undefined) {
      throw new BridgeError('LOUSHO_NO_ACTIVE_RUN', `Run '${p.runId}' is not running.`);
    }
    const steered = live.run.steer(p.message);
    const runId = p.runId;
    void steered.joined
      .then((joined) => {
        const data = { steerId: steered.id, joined };
        const current = this.records.get(runId);
        // The record may be gone already; Studio ignores pushes for unknown runs, so send anyway.
        if (current !== undefined) this.emit(current, 'steer.joined', data);
        else this.push({ event: 'steer.joined', runId, data });
      })
      .catch(() => undefined);
    return { id: steered.id, applied: steered.applied };
  }

  /**
   * `abort`: a live segment is aborted (`'aborting'`, the settle push
   * follows); a paused record has its approvals resolved delete-on-read
   * and is dropped (`'discarded'`, no push); an unknown run is `'idle'`.
   */
  async abort(p: BridgeParams['abort']): Promise<BridgeResults['abort']> {
    const record = this.records.get(p.runId);
    if (record?.live !== undefined) {
      record.live.controller.abort(new DOMException(p.reason ?? 'user', 'AbortError'));
      return { state: 'aborting' };
    }
    if (record !== undefined) {
      const approvals = bridgeSpecHost(this.root, record.params).store?.approvals;
      await Promise.all(record.pausedApprovalIds.map((id) => approvals?.resolve(id).catch(() => null) ?? Promise.resolve(null)));
      this.drop(record);
      return { state: 'discarded' };
    }
    return { state: 'idle' };
  }

  /** `resolveApproval`: continue a paused run with the human's decision on `approvalId`. */
  resolveApproval(p: BridgeParams['resolveApproval']): Promise<{ ok: true }> {
    return this.continue(p.runId, p.approvalId, (agent, signal) =>
      agent.approvals.streamResolve(
        { id: p.approvalId, approved: p.approved, ...(p.note !== undefined && { note: p.note }) },
        { signal }
      )
    );
  }

  /** `answerQuestion`: continue a paused run with the answer to `questionId`. */
  answerQuestion(p: BridgeParams['answerQuestion']): Promise<{ ok: true }> {
    return this.continue(p.runId, p.questionId, (agent, signal) =>
      agent.approvals.streamAnswer({ id: p.questionId, answer: p.answer }, { signal })
    );
  }

  /**
   * Flushes `record.queue` once the handler's response line is written
   * (server.ts calls this right after `respond`). Unknown ids are ignored.
   */
  markReady(runId: string): void {
    const record = this.records.get(runId);
    if (record === undefined) return;
    record.ready = true;
    for (const message of record.queue.splice(0)) this.push(message);
  }

  /**
   * Shutdown hook (registered with `onShutdown`): abort every live run
   * with `reason` and wait for each to settle; the grace cap lives in
   * server.ts. Paused records are left on disk — their approval files
   * stay, but a later bridge cannot resume them (the record is gone).
   */
  async abortAll(reason: string): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const record of this.records.values()) {
      if (record.live === undefined) continue;
      record.live.controller.abort(new DOMException(reason, 'AbortError'));
      // `settled` resolves after the settle push is written, so shutdown's
      // `run.settled { aborted }` always precedes the exit.
      waits.push(record.settled ?? record.live.run.result.catch(() => undefined));
    }
    await Promise.all(waits);
  }

  /** The record `runId` names, or `LOUSHO_BRIDGE_RUN_NOT_FOUND`. */
  private requireRecord(runId: string): BridgeRunRecord {
    const record = this.records.get(runId);
    if (record === undefined) throw NOT_FOUND(runId);
    return record;
  }

  /**
   * `resolveApproval`/`answerQuestion` share this: the record must be
   * paused on `id`, then a rebuilt agent continues it as a new segment
   * (`ready` false again until `markReady`; a failed start restores it).
   */
  private async continue(
    runId: string,
    id: string,
    resume: (agent: SimpleAgent, signal: AbortSignal) => AgentRun
  ): Promise<{ ok: true }> {
    const record = this.requireRecord(runId);
    if (!record.pausedApprovalIds.includes(id)) {
      throw new BridgeError('LOUSHO_APPROVAL_NOT_FOUND', `The approval '${id}' is not waiting.`);
    }
    const paused = record.pausedApprovalIds;
    record.pausedApprovalIds = [];
    record.ready = false;
    try {
      const agent = await this.build(record);
      const controller = new AbortController();
      const run = resume(agent, controller.signal);
      this.replaceAgent(record, agent);
      record.live = { run, controller };
      this.watch(record);
    } catch (error) {
      record.pausedApprovalIds = paused;
      record.ready = true;
      record.queue.length = 0;
      throw error;
    }
    return { ok: true };
  }

  /** Compiles `record.spec` and builds a fresh agent whose events/spans push under `record.runId`. */
  private async build(record: BridgeRunRecord): Promise<SimpleAgent> {
    const params = record.params;
    applyEnv(params.env);
    const exporter: TraceExporter = {
      onSpanStart: (span) => this.emit(record, 'span.start', span),
      onSpanEnd: (span) => this.emit(record, 'span.end', span),
    };
    // compileSpecWithNodeIds (what specV2ToAgent uses) so pushed spans carry
    // `lousho.node.id` like the in-process host's — Studio maps them to nodes.
    const compiled = await compileSpecWithNodeIds(record.spec, bridgeSpecHost(this.root, params, { exporter }));
    const config: CreateAgentConfig = {
      ...compiled.config,
      onEvent: (event) => this.emit(record, 'agent', event),
      exporter,
      ...(params.captureContent !== undefined && { captureContent: params.captureContent }),
    };
    return createAgent(config);
  }

  /**
   * Attaches `run.result`'s settle/fail to the record; both fire on
   * `setImmediate` so same-tick events push first, and `record.settled`
   * resolves only after the settle/fail (and its push) completed.
   */
  private watch(record: BridgeRunRecord): void {
    const { run } = record.live!;
    record.settled = run.result.then(
      (result) => this.afterTick(() => this.settle(record, result)),
      (error: unknown) => this.afterTick(() => this.fail(record, error))
    );
  }

  /** Runs `fn` on the next macrotask turn and resolves after it (and any promise it returns) settles. */
  private afterTick(fn: () => void | Promise<void>): Promise<void> {
    return new Promise((resolve) =>
      setImmediate(() => {
        void Promise.resolve()
          .then(fn)
          .catch(() => undefined)
          .finally(resolve);
      })
    );
  }

  /** A segment ended: pause bookkeeping + `run.settled`, or drop + `run.settled` for a final result. */
  private async settle(record: BridgeRunRecord, result: ExecutionResult): Promise<void> {
    record.live = undefined;
    let pendingApproval: PendingApproval | undefined;
    if (result.finishReason === 'awaiting-approval') {
      record.pausedApprovalIds = result.approvalIds ?? (result.approvalId !== undefined ? [result.approvalId] : []);
      if (result.approvalId !== undefined) {
        const approvals = bridgeSpecHost(this.root, record.params).store?.approvals;
        pendingApproval = approvals?.load !== undefined ? (await approvals.load(result.approvalId))?.pending : undefined;
      }
    } else {
      this.drop(record);
    }
    this.emit(record, 'run.settled', toRunResult(result, pendingApproval));
  }

  /** A segment failed: drop the record and push `run.failed`. */
  private fail(record: BridgeRunRecord, error: unknown): void {
    this.drop(record);
    this.emit(record, 'run.failed', toBridgeErrorInfo(error));
  }

  /** Removes the record and closes its agent (MCP connections); queued pushes are dropped with it. */
  private drop(record: BridgeRunRecord): void {
    if (this.records.get(record.runId) === record) this.records.delete(record.runId);
    record.queue.length = 0;
    void record.agent?.close().catch(() => undefined);
    record.agent = undefined;
  }

  /** Swaps in a continuation's agent, closing the paused segment's. */
  private replaceAgent(record: BridgeRunRecord, agent: SimpleAgent): void {
    const previous = record.agent;
    record.agent = agent;
    void previous?.close().catch(() => undefined);
  }

  /**
   * One push line for `record`: queued while `ready` is false, sent
   * otherwise. An `agent` event too large for one line is sent truncated
   * to its envelope (`{ type, runId, seq, truncated: true }`); an oversized
   * span is dropped with one stderr line.
   */
  private emit(record: BridgeRunRecord, event: BridgePushEvent, data: BridgePushData[BridgePushEvent]): void {
    let message = { event, runId: record.runId, data } as BridgePush;
    if (Buffer.byteLength(toWireJson(message), 'utf8') > MAX_LINE_BYTES) {
      if (event === 'agent') {
        const agent = data as Extract<BridgePushData['agent'], { type: string }>;
        message = {
          event,
          runId: record.runId,
          data: { type: agent.type, runId: agent.runId, seq: agent.seq, truncated: true },
        } as unknown as BridgePush;
      } else if (event === 'span.start' || event === 'span.end') {
        console.error(`lousho bridge: dropped oversized ${event} push for run ${record.runId}`);
        return;
      }
    }
    if (record.ready) this.push(message);
    else record.queue.push(message);
  }
}

/**
 * The `BridgeRunResult` keys of `result`, plus the paused run's
 * `pendingApproval` when there is one. Mirrors agent-forge's
 * `AgentHost` result picker on purpose: the in-process and bridge hosts
 * must emit the same run-result shape (W11b maps one onto the other).
 */
function toRunResult(result: ExecutionResult, pendingApproval: PendingApproval | undefined): BridgeRunResult {
  const view: BridgeRunResult = {
    finishReason: result.finishReason,
    text: result.text,
    messages: result.messages,
    usage: result.usage,
    steps: result.steps,
  };
  if (result.approvalId !== undefined) view.approvalId = result.approvalId;
  if (result.approvalIds !== undefined) view.approvalIds = result.approvalIds;
  if (result.abortReason !== undefined) view.abortReason = result.abortReason;
  if (result.object !== undefined) view.object = result.object;
  if (pendingApproval !== undefined) view.pendingApproval = pendingApproval;
  return view;
}
