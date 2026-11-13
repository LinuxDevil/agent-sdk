/**
 * `serveBridge`: the `lousho bridge` protocol loop (W10a; W10b adds the run
 * methods to {@link HANDLERS} and the push events). One JSON request per
 * stdin line, one JSON response or push per stdout line; stdout carries
 * protocol lines only, so `console.log/info/debug` are redirected to stderr
 * for the whole session.
 *
 * Requests are validated in order — size, JSON, id/method shape, shutdown,
 * hello gate, known method, params — and every failure is answered on the
 * request's `id` (`null` when the id itself was unusable). Handlers run
 * concurrently: a line is dispatched the moment it arrives, never queued
 * behind an in-flight request.
 */
import { createHash } from 'node:crypto';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { listBuiltinTools } from '../tools/catalog';
import { listModels } from '../models/catalog';
import { listGuardrails } from '../execution/guardrailCatalog';
import { listTriggerTypes } from '../spec/v2/triggerCatalog';
import { parseAgentSpecV2 } from '../spec/v2/parse';
import { compileSpec } from '../spec/v2/specToAgent';
import { VERSION } from '../version';
import { withConsoleOnStderr } from '../utils/consoleOnStderr';
import { BridgeError, toBridgeErrorInfo } from './bridgeError';
import { parseParams } from './params';
import { BRIDGE_PROTOCOL_VERSION, MAX_LINE_BYTES, type BridgeCatalog, type BridgeMethod, type BridgeParams, type BridgeResponse, type BridgeRunStarted } from './protocol';
import { BridgeRuns } from './runs';
import { applyEnv, bridgeSpecHost } from './specHost';
import { toWireJson } from './wireJson';

/** How long shutdown waits for registered hooks before resolving anyway. */
const SHUTDOWN_GRACE_MS = 5000;

/** The streams and project root a bridge session runs on. */
export interface BridgeIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** The project folder specs resolve against; defaults to the process cwd in `runBridge`. */
  root?: string;
}

/** Hooks run (up to {@link SHUTDOWN_GRACE_MS}) when the bridge shuts down; W10b's `abortAll('shutdown')` registers here. */
const shutdownHooks = new Set<() => void | Promise<void>>();

/** Registers `fn` to run at shutdown (W10b's `abortAll('shutdown')` lives here); returns an unregister function. */
// fallow-ignore-next-line unused-export -- contract surface: W10b registers its abortAll hook through this
export function onShutdown(fn: () => void | Promise<void>): () => void {
  shutdownHooks.add(fn);
  return () => shutdownHooks.delete(fn);
}

const TOO_LARGE = 'Message is larger than 8 MiB.';

const errorInfo = (code: string, message: string, details?: unknown) => ({ code, message, ...(details !== undefined && { details }) });

/** What the implemented handlers share: the project root, the memoized catalog and the run registry. */
interface HandlerContext {
  root: string;
  catalog(): BridgeCatalog;
  catalogHash(): string;
  runs: BridgeRuns;
}

type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

/**
 * The dispatch table: `undefined` entries are protocol methods this build
 * does not implement yet (W10b's run methods) and answer
 * `LOUSHO_BRIDGE_UNKNOWN_METHOD`.
 */
const HANDLERS: Record<BridgeMethod, Handler | undefined> = {
  hello: async (params, ctx) => {
    const { protocol } = params as BridgeParams['hello'];
    if (protocol !== BRIDGE_PROTOCOL_VERSION) {
      throw new BridgeError(
        'LOUSHO_BRIDGE_PROTOCOL',
        `This SDK speaks bridge protocol ${BRIDGE_PROTOCOL_VERSION}; got ${protocol}.`,
        { supported: [BRIDGE_PROTOCOL_VERSION] }
      );
    }
    return { sdkVersion: VERSION, specVersions: [1, 2], protocol: BRIDGE_PROTOCOL_VERSION, catalogHash: ctx.catalogHash() };
  },
  catalog: async (_params, ctx) => ctx.catalog(),
  compile: async (params, ctx) => {
    const p = params as BridgeParams['compile'];
    applyEnv(p.env);
    const spec = parseAgentSpecV2(p.spec);
    const compiled = await compileSpec(spec, bridgeSpecHost(ctx.root, p));
    return {
      modelLabel: spec.model,
      toolNamesByRef: compiled.toolNamesByRef.map((names) => [...names]),
      mcpServers: Object.keys(compiled.mcpServers),
    };
  },
  shutdown: async () => ({ ok: true }),
  run: async (params, ctx) => ctx.runs.start('run', params as BridgeParams['run']),
  chat: async (params, ctx) => ctx.runs.start('chat', params as BridgeParams['chat']),
  steer: async (params, ctx) => ctx.runs.steer(params as BridgeParams['steer']),
  abort: (params, ctx) => ctx.runs.abort(params as BridgeParams['abort']),
  resolveApproval: (params, ctx) => ctx.runs.resolveApproval(params as BridgeParams['resolveApproval']),
  answerQuestion: (params, ctx) => ctx.runs.answerQuestion(params as BridgeParams['answerQuestion']),
};

/** The `runId` a just-answered `run`/`chat`/`resolveApproval`/`answerQuestion` response belongs to, for `markReady`. */
function respondedRunId(method: BridgeMethod, params: unknown, result: unknown): string | undefined {
  if (method === 'run' || method === 'chat') return (result as BridgeRunStarted).runId;
  if (method === 'resolveApproval' || method === 'answerQuestion') return (params as { runId: string }).runId;
  return undefined;
}

const BAD_REQUEST_MESSAGE = "A request needs a numeric 'id' and a 'method'.";

/**
 * One raw stdin line down to `{ id, method, params }`, or the error
 * response to send instead (`id: null` when the id itself was unusable).
 */
function parseRequestLine(
  line: string
): { id: number; method: string; params: unknown } | { id: number | null; error: ReturnType<typeof errorInfo> } {
  const bad = (id: number | null, code: string, message: string) => ({ id, error: errorInfo(code, message) });
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return bad(null, 'LOUSHO_BRIDGE_TOO_LARGE', TOO_LARGE);
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return bad(null, 'LOUSHO_BRIDGE_BAD_JSON', 'Each line must be one JSON object.');
  }
  if (!isRecord(data)) return bad(null, 'LOUSHO_BRIDGE_BAD_JSON', 'Each line must be one JSON object.');
  const id = data.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return bad(null, 'LOUSHO_BRIDGE_BAD_REQUEST', BAD_REQUEST_MESSAGE);
  const method = data.method;
  if (typeof method !== 'string') return bad(id, 'LOUSHO_BRIDGE_BAD_REQUEST', BAD_REQUEST_MESSAGE);
  return { id, method, params: data.params };
}

/** The gate every request passes after parsing: shutdown, hello-first, known-method — or `null` to dispatch. */
function requestRejection(
  method: string,
  state: { helloDone: boolean; shuttingDown: boolean }
): ReturnType<typeof errorInfo> | null {
  if (state.shuttingDown) return errorInfo('LOUSHO_BRIDGE_SHUTTING_DOWN', 'The bridge is shutting down.');
  if (!state.helloDone && method !== 'hello') return errorInfo('LOUSHO_BRIDGE_NO_HELLO', "Send 'hello' first.");
  // hasOwn, not a plain index: 'constructor'/'__proto__' must not read Object.prototype as a handler.
  const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method as BridgeMethod] : undefined;
  if (handler === undefined) {
    return errorInfo('LOUSHO_BRIDGE_UNKNOWN_METHOD', `Unknown method '${method}'.`);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs the bridge until `shutdown` or stdin ends; resolves with the exit
 * code (0 on a clean stop, 1 when the session itself failed — request
 * errors are always answered on their `id`, never fatal).
 */
export async function serveBridge(io: Required<BridgeIo>): Promise<number> {
  return withConsoleOnStderr(async () => {
    try {
      return await serve(io);
    } catch (error) {
      io.stderr.write(`lousho bridge: ${(error as Error)?.stack ?? String(error)}\n`);
      return 1;
    }
  });
}

async function serve(io: Required<BridgeIo>): Promise<number> {
  let helloDone = false;
  let shuttingDown = false;
  let catalogCache: BridgeCatalog | undefined;
  let hashCache: string | undefined;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const catalog = (): BridgeCatalog =>
    (catalogCache ??= {
      tools: listBuiltinTools(),
      models: listModels(),
      guardrails: listGuardrails(),
      triggers: listTriggerTypes(),
    });
  const catalogHash = (): string =>
    (hashCache ??= createHash('sha256').update(JSON.stringify(catalog())).digest('hex').slice(0, 16));

  const send = (message: BridgeResponse | { event: string; runId: string; data: unknown }): void => {
    let line = toWireJson(message);
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      const id = 'id' in message ? message.id : null;
      line = toWireJson({ id, error: errorInfo('LOUSHO_BRIDGE_TOO_LARGE', TOO_LARGE) });
    }
    io.stdout.write(`${line}\n`);
  };
  const respond = (id: number, result: unknown): void => send({ id, result });
  const respondError = (id: number | null, error: { code: string; message: string; details?: unknown }): void =>
    send({ id, error });

  // W10b: the run registry pushes through `send`; `abortAll` is the shutdown hook.
  const runs = new BridgeRuns(io.root, send);
  onShutdown(() => runs.abortAll('shutdown'));
  const ctx: HandlerContext = { root: io.root, catalog, catalogHash, runs };

  const beginShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    const hooks = [...shutdownHooks];
    shutdownHooks.clear();
    const pending = hooks.map((hook) => Promise.resolve().then(hook).catch(() => undefined));
    void Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]).then(() => finish(0));
  };

  const handleLine = async (line: string): Promise<void> => {
    const parsed = parseRequestLine(line);
    if ('error' in parsed) {
      respondError(parsed.id, parsed.error);
      return;
    }
    const rejection = requestRejection(parsed.method, { helloDone, shuttingDown });
    if (rejection !== null) {
      respondError(parsed.id, rejection);
      return;
    }
    const method = parsed.method as BridgeMethod;
    try {
      const result = await HANDLERS[method]!(parseParams(method, parsed.params), ctx);
      respond(parsed.id, result);
      // The response line is on stdout now: release the run's queued pushes.
      const runId = respondedRunId(method, parsed.params, result);
      if (runId !== undefined) runs.markReady(runId);
      if (method === 'hello') helloDone = true;
      if (method === 'shutdown') beginShutdown();
    } catch (error) {
      respondError(parsed.id, toBridgeErrorInfo(error));
    }
  };

  const rl = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void handleLine(line).catch((error: unknown) => {
      io.stderr.write(`lousho bridge: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    });
  });
  rl.on('close', beginShutdown);

  return finished;
}
