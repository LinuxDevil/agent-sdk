/**
 * Approvals for createAgent() agents (LOU-D21): a thin layer over an
 * ApprovalStore and resumeAfterApproval(). It records which approvals the
 * agent paused on (for `agent.approvals.list()`), continues a paused session
 * when its approval is resolved, and - with an `approve` callback - decides
 * each pause at once by resuming the run with the callback's answer.
 */

import { describeApproval, type ApprovalDecision, type ApprovalStore, type PendingApproval } from './execution/ApprovalGate';
import type { ExecutionResult } from './execution/AgentExecutor';
import type { AgentRun } from './execution/agentRun';
import type { CheckpointStore } from './execution/checkpoint';
import { SessionAwaitingApprovalError } from './execution/errors';
import { AgentSession, type SessionOptions, type SessionRunner, type SessionStreamRunner } from './session/AgentSession';

/**
 * Decides a tool call that needs approval without pausing the run: `true`
 * runs the tool, `false` gives the model a rejection as the tool's result.
 * A string approves with that string as the note - for an `ask_question`
 * call (`request.kind === 'question'`), it is the answer (LOU-X9).
 *
 * @example
 * ```ts
 * const approve: ApproveToolCall = ({ toolName, args }) => toolName !== 'send_email' || args.to === 'me@example.com';
 * const answer: ApproveToolCall = (request) => (request.kind === 'question' ? 'Lisbon' : true);
 * ```
 */
export type ApproveToolCall = (request: PendingApproval) => boolean | string | Promise<boolean | string>;

/** `agent.approvals`: the tool calls a `createAgent()` agent is paused on, and how to decide them. */
export interface AgentApprovals {
  /** Approvals this agent paused on in this process and that are not decided yet, oldest first. */
  list(): Promise<PendingApproval[]>;
  /**
   * Approves or rejects a paused tool call (`note` is passed to the model
   * with a rejection) and continues the run, resolving with the continued
   * run's result - which may pause again. A run paused inside
   * `agent.session()` continues in that session. Throws when `id` is unknown
   * or already resolved.
   *
   * @example
   * ```ts
   * const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
   * ```
   */
  resolve(decision: ApprovalDecision, options?: { signal?: AbortSignal }): Promise<ExecutionResult>;
  /**
   * Answers a paused `ask_question` call (LOU-X9): the same as
   * `resolve({ id, approved: true, note: answer })`. The model gets
   * `{ answer, option? }` as the tool's result.
   *
   * @example
   * ```ts
   * const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'Lisbon' });
   * ```
   */
  answer(reply: { id: string; answer: string }, options?: { signal?: AbortSignal }): Promise<ExecutionResult>;
}

/**
 * resumeAfterApproval() bound to an agent's registry, provider and options;
 * `checkpointStore` is the paused session's, when its turns are checkpointed.
 */
type ResumeRun = (
  store: ApprovalStore,
  decision: ApprovalDecision,
  signal?: AbortSignal,
  checkpointStore?: CheckpointStore
) => Promise<ExecutionResult>;

/** A session whose paused turn can be continued by `agent.approvals.resolve()`. */
class ApprovalSession extends AgentSession {
  resolveWith(next: (checkpointStore?: CheckpointStore) => Promise<ExecutionResult>): Promise<ExecutionResult> {
    return this.continueTurn(() => next(this.checkpointStore));
  }
}

/** Wires an agent's approval store, `approve` callback and resume function together. */
export function createAgentApprovals(options: { store: ApprovalStore; approve?: ApproveToolCall; resume: ResumeRun }) {
  const { approve, resume } = options;
  const pending = new Map<string, PendingApproval>();
  const sessions = new Map<string, ApprovalSession>();
  const store: ApprovalStore = {
    async save(raw, snapshot) {
      // LOU-X9: an `ask_question` call is recorded as `kind: 'question'`.
      const request = describeApproval(raw);
      await options.store.save(request, snapshot);
      pending.set(request.id, request);
    },
    async resolve(id) {
      const record = await options.store.resolve(id);
      pending.delete(id);
      return record;
    },
  };

  /** With an `approve` callback, decides every pause until the run finishes. */
  async function settle(
    result: ExecutionResult,
    signal?: AbortSignal,
    checkpointStore?: CheckpointStore
  ): Promise<ExecutionResult> {
    let current = result;
    for (;;) {
      const request = current.approvalId ? pending.get(current.approvalId) : undefined;
      if (!approve || current.finishReason !== 'awaiting-approval' || !request) return current;
      const verdict = await approve(request);
      const decision = typeof verdict === 'string' ? { id: request.id, approved: true, note: verdict } : { id: request.id, approved: verdict };
      current = await resume(store, decision, signal, checkpointStore);
    }
  }

  function inSession(session: ApprovalSession | undefined, result: ExecutionResult): ExecutionResult {
    if (session && result.finishReason === 'awaiting-approval' && result.approvalId) {
      sessions.set(result.approvalId, session);
    }
    return result;
  }

  /** `run`, with a pause it reports (as an event or in its result) bound to `session`. */
  function inSessionRun(session: ApprovalSession, run: AgentRun): AgentRun {
    return {
      runId: run.runId,
      result: run.result.then((result) => inSession(session, result)),
      enqueue: (input) => run.enqueue(input),
      steer: (input) => run.steer(input),
      async *[Symbol.asyncIterator]() {
        for await (const event of run) {
          if (event.type === 'approval.requested') sessions.set(event.approvalId, session);
          yield event;
        }
      },
    };
  }

  function resolve(decision: ApprovalDecision, { signal }: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    const session = sessions.get(decision.id);
    sessions.delete(decision.id);
    const next = async (checkpointStore?: CheckpointStore) =>
      inSession(session, await settle(await resume(store, decision, signal, checkpointStore), signal, checkpointStore));
    return session ? session.resolveWith(next) : next();
  }

  const approvals: AgentApprovals = {
    list: async () => [...pending.values()],
    resolve,
    answer: ({ id, answer }, resolveOptions) => resolve({ id, approved: true, note: answer }, resolveOptions),
  };

  return {
    /** The store to run with: the agent's store, recording what is pending. */
    store,
    approvals,
    settle,
    session(run: SessionRunner, stream: SessionStreamRunner, sessionOptions?: SessionOptions): AgentSession {
      const session: ApprovalSession = new ApprovalSession(
        async (input, signal, turn, call) => {
          try {
            return inSession(session, await settle(await run(input, signal, turn, call), signal, turn?.checkpointStore));
          } catch (error) {
            // A checkpointed turn found paused (e.g. after a restart): resolving it continues this session.
            if (error instanceof SessionAwaitingApprovalError && error.approvalId) sessions.set(error.approvalId, session);
            throw error;
          }
        },
        sessionOptions,
        (input, signal, turn, call) => inSessionRun(session, stream(input, signal, turn, call))
      );
      return session;
    },
  };
}
