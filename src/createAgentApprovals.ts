/**
 * Approvals for createAgent() agents (LOU-D21): a thin layer over an
 * ApprovalStore and resumeAfterApproval(). It records which approvals the
 * agent paused on (for `agent.approvals.list()`), continues a paused session
 * when its approval is resolved, and - with an `approve` callback - decides
 * each pause at once by resuming the run with the callback's answer.
 */

import type { ApprovalDecision, ApprovalStore, PendingApproval } from './execution/ApprovalGate';
import type { ExecutionResult } from './execution/AgentExecutor';
import type { AgentRun } from './execution/agentRun';
import { AgentSession, type SessionOptions, type SessionRunner, type SessionStreamRunner } from './session/AgentSession';

/**
 * Decides a tool call that needs approval without pausing the run: `true`
 * runs the tool, `false` gives the model a rejection as the tool's result.
 *
 * @example
 * ```ts
 * const approve: ApproveToolCall = ({ toolName, args }) => toolName !== 'send_email' || args.to === 'me@example.com';
 * ```
 */
export type ApproveToolCall = (request: PendingApproval) => boolean | Promise<boolean>;

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
}

/** resumeAfterApproval() bound to an agent's registry, provider and options. */
type ResumeRun = (store: ApprovalStore, decision: ApprovalDecision, signal?: AbortSignal) => Promise<ExecutionResult>;

/** A session whose paused turn can be continued by `agent.approvals.resolve()`. */
class ApprovalSession extends AgentSession {
  resolveWith(next: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    return this.continueTurn(next);
  }
}

/** Wires an agent's approval store, `approve` callback and resume function together. */
export function createAgentApprovals(options: { store: ApprovalStore; approve?: ApproveToolCall; resume: ResumeRun }) {
  const { approve, resume } = options;
  const pending = new Map<string, PendingApproval>();
  const sessions = new Map<string, ApprovalSession>();
  const store: ApprovalStore = {
    async save(request, snapshot) {
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
  async function settle(result: ExecutionResult, signal?: AbortSignal): Promise<ExecutionResult> {
    let current = result;
    for (;;) {
      const request = current.approvalId ? pending.get(current.approvalId) : undefined;
      if (!approve || current.finishReason !== 'awaiting-approval' || !request) return current;
      current = await resume(store, { id: request.id, approved: await approve(request) }, signal);
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
      async *[Symbol.asyncIterator]() {
        for await (const event of run) {
          if (event.type === 'approval.requested') sessions.set(event.approvalId, session);
          yield event;
        }
      },
    };
  }

  const approvals: AgentApprovals = {
    list: async () => [...pending.values()],
    resolve(decision, { signal } = {}) {
      const session = sessions.get(decision.id);
      sessions.delete(decision.id);
      const next = async () => inSession(session, await settle(await resume(store, decision, signal), signal));
      return session ? session.resolveWith(next) : next();
    },
  };

  return {
    /** The store to run with: the agent's store, recording what is pending. */
    store,
    approvals,
    settle,
    session(run: SessionRunner, stream: SessionStreamRunner, sessionOptions?: SessionOptions): AgentSession {
      const session: ApprovalSession = new ApprovalSession(
        async (input, signal) => inSession(session, await settle(await run(input, signal), signal)),
        sessionOptions,
        (input, signal) => inSessionRun(session, stream(input, signal))
      );
      return session;
    },
  };
}
