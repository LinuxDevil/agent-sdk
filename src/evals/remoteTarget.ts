/**
 * Remote eval target (LOU-D47): runs an eval case against a deployed agent
 * (`loushy deploy` node server or Cloudflare Worker) over its session API,
 * `POST /chat { sessionId, input }` streamed as SSE, and turns the streamed
 * events into the `ExecutionResult` the in-process path produces, so checks,
 * scorers, the judge and the reporters work unchanged.
 */
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentEvent, AgentEventOf } from '../execution/agentEvents';
import { SDKError } from '../execution/errors';
import type { AgentInput } from '../providers/content';
import type { ToolCall } from '../providers/llm';
import { parseEventStream } from '../ui/parseEventStream';
import { newId } from '../utils/id';

/** What an eval case needs from the thing under test: `send()`. A `createAgent()` agent has it, and so does a remote target. */
export interface EvalTarget {
  send(input: AgentInput): Promise<ExecutionResult>;
}

/** Environment variables `loushy eval --url` / `--token` hand to the vitest worker. */
export const REMOTE_URL_ENV = 'LOUSHY_EVAL_URL';
export const REMOTE_TOKEN_ENV = 'LOUSHY_EVAL_TOKEN';

/** Options of {@link remoteTarget}. */
export interface RemoteTargetOptions {
  /** Base URL of the deployed agent, e.g. `https://agent.example.com` (the `/chat` routes live under it). */
  url: string;
  /** Bearer token (`LOUSHY_API_TOKEN` of the deployment). Never printed or put in a report. */
  auth?: string;
  /** `fetch` to use; defaults to the global one. Tests pass an in-process handler. */
  fetch?: typeof fetch;
}

/** An {@link ExecutionResult} built from a stream, and what that stream did not carry. */
export interface RemoteExecutionResult extends ExecutionResult {
  /** Data the checks need but the stream did not carry: `'usage'` and/or `'steps'`. */
  missing: Array<'usage' | 'steps'>;
}

const fail = (message: string, code: string, cause?: unknown) => new SDKError(`loushy eval --url: ${message}`, code, { cause });

function toResult(events: readonly AgentEvent[]): RemoteExecutionResult {
  const done = events.find((e): e is AgentEventOf<'run.done'> => e.type === 'run.done');
  if (!done) throw fail('the stream ended without a run.done event (truncated or not an agent session stream)', 'LOUSHY_REMOTE_REQUEST_FAILED');
  const own = events.filter((e) => !e.subagent);
  const toolCalls: ToolCall[] = own
    .filter((e): e is AgentEventOf<'tool.start'> => e.type === 'tool.start')
    .map((e) => ({ id: e.toolCallId, type: 'function', function: { name: e.toolName, arguments: JSON.stringify(e.args) } }));
  const steps = own.filter((e) => e.type === 'step.done').length;
  const u = done.usage;
  const usage = {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
    promptTokens: u?.inputTokens ?? 0,
    completionTokens: u?.outputTokens ?? 0,
    costUsd: u?.costUsd,
    modelCalls: u?.modelCalls ?? steps,
    estimated: u?.estimated ?? false,
    byModel: {},
  };
  const missing: RemoteExecutionResult['missing'] = [...(u ? [] : (['usage'] as const)), ...(steps === 0 ? (['steps'] as const) : [])];
  return { text: done.text, messages: [], toolCalls, usage, finishReason: done.finishReason, steps, missing };
}

async function post(options: RemoteTargetOptions, sessionId: string, input: AgentInput): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
  const target = `${options.url.replace(/\/+$/, '')}/chat`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(target, { method: 'POST', headers, body: JSON.stringify({ sessionId, input }) });
  } catch (error) {
    throw fail(`could not reach ${target}: ${error instanceof Error ? error.message : String(error)}`, 'LOUSHY_REMOTE_REQUEST_FAILED', error);
  }
  if (response.status === 401) throw fail(`${target} answered 401 Unauthorized`, 'LOUSHY_REMOTE_UNAUTHORIZED');
  if (!response.ok) throw fail(`${target} answered ${response.status} ${response.statusText}`.trim(), 'LOUSHY_REMOTE_REQUEST_FAILED');
  return response;
}

async function collect(response: Response): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of parseEventStream(response)) events.push(event);
  } catch (error) {
    throw fail(`the event stream broke: ${error instanceof Error ? error.message : String(error)}`, 'LOUSHY_REMOTE_REQUEST_FAILED', error);
  }
  return events;
}

/**
 * An eval target that runs on a deployed agent: pass it as `target` to
 * `defineEval()`. Every case gets its own remote session, so `t.send()` calls
 * of one case continue one conversation; the case input goes over
 * `POST /chat` and the SSE stream is read to the end.
 *
 * Failures (unreachable, 401, other non-2xx, a truncated stream) throw an
 * `SDKError` (`LOUSHY_REMOTE_UNAUTHORIZED`, `LOUSHY_REMOTE_REQUEST_FAILED`),
 * which fails the case. Results carry `missing` when the stream had no usage.
 *
 * @example
 * ```ts
 * defineEval({
 *   name: 'smoke',
 *   target: remoteTarget({ url: 'https://agent.example.com', auth: process.env.LOUSHY_EVAL_TOKEN }),
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
    return { send: async (input) => toResult(await collect(await post(options, sessionId, input))) };
  };
}

/** The target `loushy eval --url` asked for (through the worker's environment), if any. */
export function remoteTargetFromEnv(env: Record<string, string | undefined> = process.env): (() => EvalTarget) | undefined {
  const url = env[REMOTE_URL_ENV];
  return url ? remoteTarget({ url, auth: env[REMOTE_TOKEN_ENV] || undefined }) : undefined;
}
