/**
 * `runDraft` (PLAN §8.2, AA20): runs an agent's saved working copy once,
 * capped at {@link RUN_DRAFT_TIMEOUT_MS}, and returns the trace id,
 * status, clipped final text and errors. The run goes through the
 * session's own workspace's RunManager (`(await deps.workspace()).runs`,
 * the §19.3 seam - never a closed-over singleton), so it shows in the
 * agent's Test pane like a UI run and writes its trace under the
 * workspace root for `getTrace` to read. It cannot run an unsaved
 * proposal: `run(agentId, input)` with no spec argument is, by
 * definition, the saved working copy.
 */
import { defineTool, SDKError } from '@linuxdevil/lousho';
import { z } from 'zod';
import { AgentNotFoundError, AlreadyRunningError, type RunManager } from '../../runRegistry';
import { isValidAgentId } from '../../../shared/agentId';
import type { AgentRunStatusPayload } from '../../../shared/wireTypes';
import type { AuthorToolFailure } from '../../../shared/authorWire';
import type { AuthorToolFactory } from './index';
import { guardedToolCall, toolFailure } from './failure';
import { clip } from './clip';

/** Longest a draft run may take before the tool stops it and reports `timeout`. */
export const RUN_DRAFT_TIMEOUT_MS = 60_000;

/** Character cap on the returned `resultText` (the run's full text stays out of the tool result). */
const RESULT_TEXT_LIMIT = 4000;

/** `runDraft`'s `ok: true` output (PLAN §8.2). */
export interface RunDraftOutput {
  ok: true;
  agentId: string;
  /** The run's root span id once its first span started; null when the run never produced a span. */
  traceId: string | null;
  status: 'done' | 'error' | 'stopped' | 'timeout' | 'awaiting_approval';
  /** The run's final text, clipped to 4000 chars + '…'. */
  resultText: string;
  /** `status.error` on a failed run, or the pending-approval message for `awaiting_approval`. */
  errors: string[];
  durationMs: number;
}

/** What {@link waitForTerminalStatus} resolves with: the run's terminal payload, or why the wait ended early. */
type RunWaitOutcome =
  | { kind: 'terminal'; status: AgentRunStatusPayload }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/** A pending terminal-status wait: the promise, plus `cancel()` for the path that never awaits it (a failed `run()`). */
interface RunWait {
  promise: Promise<RunWaitOutcome>;
  cancel(): void;
}

/** The statuses the tool waits for: a settled run, or a pause on a tool approval. */
function isTerminal(payload: AgentRunStatusPayload): boolean {
  return (
    payload.status === 'done' ||
    payload.status === 'error' ||
    payload.status === 'stopped' ||
    (payload.status === 'paused' && payload.reason === 'awaiting_approval')
  );
}

/**
 * Resolves on the agent's first terminal status (`done`/`error`/
 * `stopped`, or `paused` awaiting approval), on `timeoutMs`, or on
 * `signal` abort - whichever comes first. The `status` listener is
 * subscribed the moment this is called, so a run that settles inside the
 * `run()` call itself is not missed; every path unsubscribes it again
 * (no leaks across turns).
 */
function waitForTerminalStatus(
  runManager: RunManager,
  agentId: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): RunWait {
  let done = false;
  let resolve!: (outcome: RunWaitOutcome) => void;
  const promise = new Promise<RunWaitOutcome>((res) => {
    resolve = res;
  });
  const onStatus = (payload: AgentRunStatusPayload) => {
    if (payload.agentId === agentId && isTerminal(payload)) {
      finish({ kind: 'terminal', status: payload });
    }
  };
  const timer = setTimeout(() => finish({ kind: 'timeout' }), options.timeoutMs);
  const onAbort = () => finish({ kind: 'aborted' });
  function cleanup(): void {
    clearTimeout(timer);
    runManager.off('status', onStatus);
    options.signal?.removeEventListener('abort', onAbort);
  }
  function finish(outcome: RunWaitOutcome): void {
    if (done) return;
    done = true;
    cleanup();
    resolve(outcome);
  }
  runManager.on('status', onStatus);
  if (options.signal?.aborted) {
    finish({ kind: 'aborted' });
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  return { promise, cancel: () => finish({ kind: 'aborted' }) };
}

/** `AGENT_NOT_FOUND`, same copy as getCurrentSpec (AA06). */
function agentNotFoundFailure(agentId: string): AuthorToolFailure {
  return toolFailure(
    'AGENT_NOT_FOUND',
    `No agent with id "${agentId}".`,
    "That agent doesn't exist.",
    'Call listAgents and copy an id from it.'
  );
}

/** `RUN_BUSY` - the agent already has a live or paused run (e.g. from the Test pane). */
function runBusyFailure(agentId: string): AuthorToolFailure {
  return toolFailure(
    'RUN_BUSY',
    `Agent "${agentId}" is already running, for example from the Test pane.`,
    'That agent is already running.',
    'Wait for it to finish, or ask the user to stop it, then try again.'
  );
}

/** `message` of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The parenthesised code of a start failure: the SDKError code, an Error's name, or 'Error'. */
function codeOf(error: unknown): string {
  if (error instanceof SDKError) return error.code;
  return error instanceof Error ? error.name : 'Error';
}

/** What a `run()` rejection maps to: the busy race, the deleted-spec race, or `RUN_FAILED`. */
function runStartFailure(agentId: string, error: unknown): AuthorToolFailure {
  if (error instanceof AlreadyRunningError) return runBusyFailure(agentId);
  if (error instanceof AgentNotFoundError) return agentNotFoundFailure(agentId);
  return toolFailure(
    'RUN_FAILED',
    `The run could not start: ${messageOf(error)} (${codeOf(error)}).`,
    "The test run couldn't start.",
    'Tell the user what is missing. For a provider key, point them to Settings with openPage.'
  );
}

/** The `ok: true` envelope every runDraft path returns. */
function runDraftOutput(
  agentId: string,
  status: RunDraftOutput['status'],
  final: AgentRunStatusPayload,
  durationMs: number,
  errors: string[]
): RunDraftOutput {
  return {
    ok: true,
    agentId,
    traceId: final.traceId ?? null,
    status,
    resultText: clip(final.resultText ?? '', RESULT_TEXT_LIMIT),
    errors,
    durationMs,
  };
}

/** AA20's runDraft: one run of the saved working copy, waited on to its terminal status or the 60 s cap. */
export const runDraftTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'runDraft',
    description:
      "Run an agent's saved working copy once with your input, for up to 60 seconds, and get the trace id, status, final text and errors. It cannot run an unsaved proposal.",
    input: z.object({
      agentId: z.string().min(1).max(128).describe('Id of a saved agent.'),
      input: z.string().min(1).max(4000).describe('The user message to run the agent with.'),
    }),
    execute: ({ agentId, input }) =>
      guardedToolCall('runDraft', async (): Promise<RunDraftOutput | AuthorToolFailure> => {
        const workspace = await deps.workspace();
        if (!isValidAgentId(agentId) || !workspace.repo.exists(agentId)) {
          return agentNotFoundFailure(agentId);
        }
        const runManager = workspace.runs;
        const current = runManager.status(agentId);
        if (current.status === 'running' || current.status === 'paused') {
          return runBusyFailure(agentId);
        }
        // An already-aborted turn starts no run at all (there is nothing to stop).
        if (turn.signal.aborted) {
          return runDraftOutput(agentId, 'stopped', runManager.status(agentId), 0, []);
        }
        // Subscribe before run() so a run that settles inside the call is not missed.
        const wait = waitForTerminalStatus(runManager, agentId, {
          timeoutMs: RUN_DRAFT_TIMEOUT_MS,
          signal: turn.signal,
        });
        const startedAt = Date.now();
        try {
          await runManager.run(agentId, input);
        } catch (error) {
          wait.cancel();
          return runStartFailure(agentId, error);
        }
        const outcome = await wait.promise;
        const durationMs = Date.now() - startedAt;
        if (outcome.kind !== 'terminal') {
          runManager.stop(agentId);
          return runDraftOutput(agentId, outcome.kind === 'timeout' ? 'timeout' : 'stopped', runManager.status(agentId), durationMs, []);
        }
        const final = outcome.status;
        if (final.status === 'paused' && final.reason === 'awaiting_approval') {
          // stop() discards the pending approval and marks the run stopped.
          runManager.stop(agentId);
          const toolName = final.pendingApproval?.toolName ?? 'unknown';
          return runDraftOutput(agentId, 'awaiting_approval', final, durationMs, [
            `Waiting for approval of ${toolName}; the test run was stopped.`,
          ]);
        }
        const errors = final.status === 'error' ? [final.error ?? 'The run failed.'] : [];
        return runDraftOutput(agentId, final.status as 'done' | 'error' | 'stopped', final, durationMs, errors);
      }),
  });
