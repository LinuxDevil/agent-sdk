/**
 * Ops pipeline: Grafana/Datadog error-signal monitor (LOU-J4).
 *
 * Receives an ErrorSignal (from a Grafana or Datadog alert webhook, or from
 * the mock sender in mocks/ for the demo), dedupes it by `signature` so a
 * flapping/retried alert never triggers more than one agent run, and - on a
 * genuinely new signature - calls the REAL static AgentExecutor.execute()
 * (src/execution/AgentExecutor.ts) exactly once with a prompt built by
 * buildMonitorPrompt().
 *
 * A small HTTP listener (startMonitorServer) exposes this as `POST
 * /webhook`, reusing the same http.createServer pattern already
 * established in src/cli/dev.ts: bound to localhost by default, and a
 * request-body size cap so an oversized payload can't exhaust memory.
 */
import * as http from 'node:http';
import { closeServer, listenOn, sendJson, sendNotFound } from './httpHelpers';
import { AgentExecutor, ExecuteOptions, ExecutionResult } from '../../src/execution/AgentExecutor';

/**
 * A single error/incident signal from a monitoring source.
 */
export interface ErrorSignal {
  /** Stable identity for this specific error condition, used for dedup. */
  signature: string;
  service: 'grafana' | 'datadog';
  message: string;
  logs: string;
}

/**
 * Everything AgentExecutor.execute() needs EXCEPT `input` - handleErrorSignal
 * builds `input` itself from the signal via buildMonitorPrompt().
 */
export type MonitorExecuteOptions = Omit<ExecuteOptions, 'input'>;

/**
 * Module-level default dedup set, used when handleErrorSignal() is called
 * without an explicit `seen` set (e.g. from startMonitorServer(), where one
 * long-lived set should track dedup for the life of the process). Tests
 * pass their own Set so cases stay isolated from each other and from this
 * module-level state.
 */
const defaultSeenSignatures = new Set<string>();

/**
 * Builds the prompt sent to the monitor agent for a given signal.
 */
export function buildMonitorPrompt(signal: ErrorSignal): string {
  return [
    `A ${signal.service} alert fired with signature "${signal.signature}".`,
    `Message: ${signal.message}`,
    '',
    'Logs:',
    signal.logs,
    '',
    'Diagnose this and delegate a fix request to the fixer agent if one is available.',
  ].join('\n');
}

/**
 * Handles one incoming ErrorSignal: deduped by `signal.signature` via an
 * in-memory Set - if this signature has already been seen, returns
 * immediately without calling the executor at all. Otherwise records the
 * signature and calls the real AgentExecutor.execute() exactly once.
 */
export async function handleErrorSignal(
  signal: ErrorSignal,
  executeOptions: MonitorExecuteOptions,
  seen: Set<string> = defaultSeenSignatures
): Promise<ExecutionResult | undefined> {
  if (seen.has(signal.signature)) {
    return undefined;
  }
  seen.add(signal.signature);

  return AgentExecutor.execute({
    ...executeOptions,
    input: buildMonitorPrompt(signal),
  });
}

/** Body-size cap for POST /webhook, matching src/cli/dev.ts's /chat convention. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

class PayloadTooLargeError extends Error {}

// Keeps draining past the cap (rather than destroying the stream) so the
// client can finish writing; the 413 is sent once the request has ended.
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= MAX_BODY_BYTES) chunks.push(Buffer.from(chunk));
  }
  if (bytes > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface MonitorServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export interface StartMonitorServerOptions {
  executeOptions: MonitorExecuteOptions;
  host?: string;
  port?: number;
  seen?: Set<string>;
  /** Called after each handled (non-duplicate) signal, mainly for tests/demo logging. */
  onResult?: (signal: ErrorSignal, result: ExecutionResult) => void;
}

function isErrorSignal(signal: Partial<ErrorSignal>): signal is ErrorSignal {
  return (
    typeof signal.signature === 'string' &&
    typeof signal.service === 'string' &&
    typeof signal.message === 'string' &&
    typeof signal.logs === 'string'
  );
}

/** Handles one `POST /webhook` request: validates the payload, runs it through dedup + the executor. */
async function handleWebhookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: StartMonitorServerOptions,
  seen: Set<string>
): Promise<void> {
  try {
    const body = await readBody(req);
    const signal = JSON.parse(body || '{}') as Partial<ErrorSignal>;
    if (!isErrorSignal(signal)) {
      sendJson(res, 400, {
        error: 'Request body must be an ErrorSignal {signature, service, message, logs}',
      });
      return;
    }

    const result = await handleErrorSignal(signal, options.executeOptions, seen);
    if (result && options.onResult) {
      options.onResult(signal, result);
    }

    sendJson(res, 202, { deduped: result === undefined });
  } catch (error) {
    const status = error instanceof PayloadTooLargeError ? 413 : 500;
    sendJson(res, status, { error: (error as Error).message });
  }
}

/**
 * Starts an HTTP server exposing `POST /webhook` for ErrorSignal payloads.
 * Bound to '127.0.0.1' by default (localhost-only), matching src/cli/dev.ts's
 * security posture for local tooling - pass an explicit host to opt in to
 * wider access.
 */
export async function startMonitorServer(
  options: StartMonitorServerOptions
): Promise<MonitorServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const seen = options.seen ?? defaultSeenSignatures;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      void handleWebhookRequest(req, res, options, seen);
      return;
    }
    sendNotFound(res);
  });

  const actualPort = await listenOn(server, port, host);

  return {
    server,
    port: actualPort,
    close: () => closeServer(server),
  };
}
