/**
 * Remote eval target (LOU-D47): runs an eval case against a deployed agent
 * (`lousho deploy` node server or Cloudflare Worker) over its session API,
 * `POST /chat { sessionId, input }` streamed as SSE, and turns the streamed
 * events into the `ExecutionResult` the in-process path produces, so checks,
 * scorers, the judge and the reporters work unchanged.
 */
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentInput } from '../providers/content';
import { runRemoteTurn, type SessionTurnSummary } from '../server/sessionClient';
import { newId } from '../utils/id';

/** What an eval case needs from the thing under test: `send()`. A `createAgent()` agent has it, and so does a remote target. */
export interface EvalTarget {
  send(input: AgentInput): Promise<ExecutionResult>;
}

/** Environment variables `lousho eval --url` / `--token` hand to the vitest worker. */
export const REMOTE_URL_ENV = 'LOUSHO_EVAL_URL';
export const REMOTE_TOKEN_ENV = 'LOUSHO_EVAL_TOKEN';

/** Options of {@link remoteTarget}. */
export interface RemoteTargetOptions {
  /** Base URL of the deployed agent, e.g. `https://agent.example.com` (the `/chat` routes live under it). */
  url: string;
  /** Bearer token (`LOUSHO_API_TOKEN` of the deployment). Never printed or put in a report. */
  auth?: string;
  /** `fetch` to use; defaults to the global one. Tests pass an in-process handler. */
  fetch?: typeof fetch;
}

/** An {@link ExecutionResult} built from a stream, and what that stream did not carry. */
export interface RemoteExecutionResult extends ExecutionResult {
  /** Data the checks need but the stream did not carry: `'usage'` and/or `'steps'`. */
  missing: Array<'usage' | 'steps'>;
}

const LABEL = 'lousho eval --url: the deployment';

function toResult(summary: SessionTurnSummary): RemoteExecutionResult {
  const { usage: u, steps, toolCalls } = summary;
  const [inputTokens, outputTokens] = [u?.inputTokens ?? 0, u?.outputTokens ?? 0];
  const tokens = { inputTokens, outputTokens, totalTokens: u?.totalTokens ?? 0, promptTokens: inputTokens, completionTokens: outputTokens };
  const usage = { ...tokens, costUsd: u?.costUsd, modelCalls: u?.modelCalls ?? steps, estimated: u?.estimated ?? false, byModel: {} };
  const missing: RemoteExecutionResult['missing'] = [...(u ? [] : (['usage'] as const)), ...(steps === 0 ? (['steps'] as const) : [])];
  return { text: summary.text, messages: [], toolCalls, usage, finishReason: summary.finishReason, steps, missing };
}

/**
 * An eval target that runs on a deployed agent: pass it as `target` to
 * `defineEval()`. Every case gets its own remote session, so `t.send()` calls
 * of one case continue one conversation; the case input goes over
 * `POST /chat` and the SSE stream is read to the end.
 *
 * Failures (unreachable, 401, other non-2xx, a truncated stream) throw an
 * `SDKError` (`LOUSHO_REMOTE_UNAUTHORIZED`, `LOUSHO_REMOTE_REQUEST_FAILED`),
 * which fails the case. Results carry `missing` when the stream had no usage.
 *
 * @example
 * ```ts
 * defineEval({
 *   name: 'smoke',
 *   target: remoteTarget({ url: 'https://agent.example.com', auth: process.env.LOUSHO_EVAL_TOKEN }),
 *   async test(t) {
 *     await t.send('Refund order 42');
 *     t.completed();
 *   },
 * });
 * ```
 */
export function remoteTarget(options: RemoteTargetOptions): () => EvalTarget {
  return () => {
    const sessionId = `eval-${newId()}`;
    return {
      send: async (input) => toResult(await runRemoteTurn(options, { sessionId, input, label: LABEL })),
    };
  };
}

/** The target `lousho eval --url` asked for (through the worker's environment), if any. */
export function remoteTargetFromEnv(env: Record<string, string | undefined> = process.env): (() => EvalTarget) | undefined {
  const url = env[REMOTE_URL_ENV];
  return url ? remoteTarget({ url, auth: env[REMOTE_TOKEN_ENV] || undefined }) : undefined;
}
