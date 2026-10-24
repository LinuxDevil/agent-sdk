/**
 * `POST /playground/run` - runs a one-off prompt (messages + `{var}`
 * variables + a `provider/model` string) and streams it back as SSE.
 *
 * The run reuses buildAgent.ts's provider/tool resolution (a stored key in
 * secretsStore beats the env var; a real provider with no key fails with
 * `LOUSHO_PROVIDER_MISSING_API_KEY`) by compiling the request into a
 * throwaway `AgentSpec` named `playground`. Every run reports to the observe
 * daemon the Studio reads (`LOUSHO_OBSERVE_URL`, default
 * `http://127.0.0.1:7777`, the same target as observeProxy.ts) as agent
 * `playground`, through the SDK's own `observeExporter()` - so a daemon that
 * is down only means the reporter drops-and-counts; the stream never waits on
 * it. When `LOUSHO_OBSERVE` is set for the studio process, its reporter is
 * used instead, so the run is not reported twice.
 *
 * `promptRef` (`name`, `name@label`, `name@3`) is only recorded, as the root
 * span's `lousho.prompt.ref` attribute: the client already sends the resolved
 * messages, so the server does not fetch the prompt again.
 */
import type { Express, Response } from 'express';
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { InMemoryApprovalStore, SDKError, type AgentEvent, type AgentSpec, type Message } from '@lousho/build-ai-agent';
import {
  fanOutExporters,
  observeExporter,
  observeExporterFromEnv,
  type ObserveExporterOptions,
  type Span,
  type TraceExporter,
} from '@lousho/build-ai-agent/traces';
import { buildAgentFromSpec } from './buildAgent';
import { observeTarget } from './observeProxy';
import type { SecretsStore } from './secretsStore';

/** The agent name every playground run reports under. */
const PLAYGROUND_AGENT_NAME = 'playground';
/** Root-span attribute naming the registry prompt the playground run came from. */
const PROMPT_REF_ATTR = 'lousho.prompt.ref';

const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 200;

interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The validated `POST /playground/run` body. */
interface PlaygroundRunRequest {
  messages: PlaygroundMessage[];
  variables?: Record<string, string>;
  /** `provider/model` (`openai/gpt-4o-mini`, `mock`, `ollama/llama3.2`). */
  model: string;
  /** Tool names the Studio already resolves (`current-date`, `day-name`, `http`, `web-fetch`, `demo-approval`). */
  tools?: string[];
  promptRef?: string;
}

/** One SSE `data:` payload of the stream. */
export type PlaygroundEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'done'; finishReason: string; text: string; traceId?: string; usage?: unknown }
  | { type: 'error'; message: string; code?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isMessage = (value: unknown): value is PlaygroundMessage =>
  isRecord(value) && typeof value.role === 'string' && ROLES.has(value.role) && typeof value.content === 'string';

function messagesError(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return `'messages' must be a non-empty array of at most ${MAX_MESSAGES} messages`;
  }
  if (!messages.every(isMessage)) {
    return "every message must be { role: 'system' | 'user' | 'assistant', content: string }";
  }
  return undefined;
}

function optionalFieldsError(body: Record<string, unknown>): string | undefined {
  const { variables, tools, promptRef } = body;
  if (variables !== undefined && !(isRecord(variables) && Object.values(variables).every((v) => typeof v === 'string'))) {
    return "'variables' must be an object of string values";
  }
  if (tools !== undefined && !isStringArray(tools)) return "'tools' must be an array of tool names";
  if (promptRef !== undefined && (typeof promptRef !== 'string' || !promptRef.trim())) {
    return "'promptRef' must be a non-empty string";
  }
  return undefined;
}

/** The validated request, or the 400 message. */
function parsePlaygroundRequest(body: unknown): PlaygroundRunRequest | string {
  if (!isRecord(body)) return 'Request body must be a JSON object';
  const invalid =
    messagesError(body.messages) ??
    (typeof body.model !== 'string' || !body.model.trim() ? "'model' must be a non-empty 'provider/model' string" : undefined) ??
    optionalFieldsError(body);
  return invalid ?? (body as unknown as PlaygroundRunRequest);
}

/** `{name}` placeholders replaced by `variables[name]`; unknown placeholders are left as they are. */
export function substituteVariables(content: string, variables: Record<string, string> = {}): string {
  return content.replace(/\{([A-Za-z_][\w.-]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : whole
  );
}

/** `provider/model` split at the first `/`; a bare `mock` names the provider alone. */
function providerOf(model: string): AgentSpec['provider'] {
  const slash = model.indexOf('/');
  return slash === -1 ? { type: model.trim(), model: '' } : { type: model.slice(0, slash).trim(), model: model.slice(slash + 1).trim() };
}

const isLoopbackUrl = (url: string): boolean => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Content capture defaults on for a loopback collector, as `createAgent` does under `LOUSHO_OBSERVE`. */
function envTargetIsLoopback(): boolean {
  const value = process.env.LOUSHO_OBSERVE?.trim() ?? '';
  return /^(1|true|on|yes)$/i.test(value) || isLoopbackUrl(value);
}

/**
 * Stamps `lousho.prompt.ref` on the run's root span and remembers its id (the
 * observe trace id). It mutates the span in place and runs first in the
 * fan-out, so every exporter after it - the observe reporter, and the
 * `LOUSHO_OBSERVE` one AgentExecutor adds - sees the attribute.
 */
function rootSpanStamper(promptRef: string | undefined, onRoot: (id: string) => void): TraceExporter {
  const stamp = (span: Span): void => {
    if (span.parentId !== undefined) return;
    onRoot(span.id);
    if (promptRef) span.attributes = { ...span.attributes, [PROMPT_REF_ATTR]: promptRef };
  };
  return { onSpanStart: stamp, onSpanEnd: stamp };
}

export interface PlaygroundOptions {
  secretsStore: SecretsStore;
  /** Project dir the reporter's `.lousho/identity/` lives under. */
  baseDir: string;
  /** Reporter overrides (tests: `fetchFn`, `registerExitHooks`, `flushIntervalMs`); the agent name stays `playground`. */
  observe?: Partial<ObserveExporterOptions>;
}

interface PlaygroundReporting {
  exporter: () => TraceExporter;
  captureContent: () => boolean;
}

/** The observe reporter, made on the first run (no heartbeat until the playground is used). */
function playgroundReporting(options: PlaygroundOptions): PlaygroundReporting {
  let own: TraceExporter | undefined;
  const url = () => options.observe?.url ?? observeTarget();
  const fromEnv = () => (options.observe ? undefined : observeExporterFromEnv({ agentName: PLAYGROUND_AGENT_NAME }));
  return {
    exporter: () =>
      fromEnv() ??
      (own ??= observeExporter({ cwd: options.baseDir, ...options.observe, url: url(), agentName: PLAYGROUND_AGENT_NAME })),
    captureContent: () => (fromEnv() ? envTargetIsLoopback() : isLoopbackUrl(url())),
  };
}

function openSse(res: Response): (event: PlaygroundEvent) => void {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();
  return (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

const errorEvent = (error: unknown): PlaygroundEvent => ({
  type: 'error',
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof SDKError ? { code: error.code } : {}),
});

/** One AgentEvent as the playground's event, or `undefined` for the ones it does not forward. */
function playgroundEventOf(event: AgentEvent, traceId: string | undefined): PlaygroundEvent | undefined {
  switch (event.type) {
    case 'text.delta':
      return { type: 'delta', text: event.text };
    case 'tool.start':
      return { type: 'tool_call', id: event.toolCallId, name: event.toolName, args: event.args };
    case 'run.done':
      return event.finishReason === 'error'
        ? undefined
        : { type: 'done', finishReason: event.finishReason, text: event.text, ...(traceId ? { traceId } : {}), ...(event.usage ? { usage: event.usage } : {}) };
    default:
      return undefined;
  }
}

function playgroundSpec(request: PlaygroundRunRequest): AgentSpec {
  return { name: PLAYGROUND_AGENT_NAME, prompt: '', provider: providerOf(request.model), ...(request.tools?.length ? { tools: request.tools } : {}) };
}

async function streamRun(res: Response, request: PlaygroundRunRequest, options: PlaygroundOptions, reporting: PlaygroundReporting): Promise<void> {
  const send = openSse(res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let traceId: string | undefined;
  try {
    const built = buildAgentFromSpec(playgroundSpec(request), PLAYGROUND_AGENT_NAME, undefined, { secretsStore: options.secretsStore });
    const input: Message[] = request.messages.map((m) => ({ role: m.role, content: substituteVariables(m.content, request.variables) }));
    const run = AgentExecutor.stream({
      agent: built.agent,
      provider: built.provider,
      ...(built.toolRegistry ? { toolRegistry: built.toolRegistry } : {}),
      input,
      skipSystemPromptInjection: true,
      // A tool that needs approval pauses the run (done: 'awaiting-approval'); the playground has no resume.
      approvalStore: new InMemoryApprovalStore(),
      signal: abort.signal,
      captureContent: reporting.captureContent(),
      exporter: fanOutExporters([rootSpanStamper(request.promptRef, (id) => (traceId = id)), reporting.exporter()]),
    });
    let failure: PlaygroundEvent | undefined;
    for await (const event of run) {
      if (event.type === 'error') failure ??= { type: 'error', message: event.error.message };
      const mapped = playgroundEventOf(event, traceId);
      if (mapped) send(mapped);
      else if (event.type === 'run.done' && event.finishReason === 'error') send(failure ?? { type: 'error', message: 'The run failed' });
    }
    await run.result.catch(() => undefined);
  } catch (error) {
    // Unknown provider, missing key, unknown tool: the run never started.
    send(errorEvent(error));
  }
  res.end();
}

/** Registers `POST /playground/run`. */
export function registerPlaygroundRoute(app: Express, options: PlaygroundOptions): void {
  const reporting = playgroundReporting(options);
  app.post('/playground/run', (req, res, next) => {
    const parsed = parsePlaygroundRequest(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    streamRun(res, parsed, options, reporting).catch(next);
  });
}
