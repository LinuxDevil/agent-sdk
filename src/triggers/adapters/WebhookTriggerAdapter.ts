/**
 * Webhook trigger adapter (LOU-T5).
 *
 * Generalizes AgentSpec's existing `triggers` field (see
 * `AgentSpecTrigger` in src/spec/schema.ts, an open `{type, ...}` record
 * that a webhook-shaped trigger entry would use `type: 'webhook'` under)
 * into a real, runnable adapter: starts a plain Node `http` server, and on
 * each inbound POST request runs the agent and writes the result straight
 * back as the HTTP response.
 *
 * Reply semantics: the reply target IS the still-open HTTP response - no
 * separate `reply()` method is implemented (see types.ts's doc comment for
 * why this differs from Slack/cron).
 */
import * as http from 'node:http';
import type { ExecutionResult } from '../../execution/AgentExecutor';
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';

export interface WebhookTriggerAdapterOptions {
  /** Port to listen on. Defaults to 0 (OS-assigned ephemeral port - inspect `handle.port` after `listen()`). */
  port?: number;
  /** Host to bind to. Defaults to '0.0.0.0'. */
  host?: string;
  /** Only requests to this path are handled; everything else gets a 404. Defaults to '/'. */
  path?: string;
}

export interface WebhookTriggerHandle extends TriggerHandle {
  /** The actual port the server bound to (useful when `options.port` was 0/omitted). */
  readonly port: number;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

/** The agent input for a raw request body: its JSON `input` string if it has one, else the body itself. */
function parseWebhookInput(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { input?: unknown };
    return typeof parsed.input === 'string' ? parsed.input : raw;
  } catch {
    return raw;
  }
}

type WebhookOnEvent = (input: string, context: TriggerContext) => Promise<ExecutionResult>;

async function respondWithAgentResult(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onEvent: WebhookOnEvent
): Promise<void> {
  try {
    const input = parseWebhookInput(await readBody(req));
    const result = await onEvent(input, { channel: res, request: req });
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, 500, { error: (error as Error).message });
  }
}

async function handleWebhookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  onEvent: WebhookOnEvent
): Promise<void> {
  if (req.method !== 'POST' || req.url !== path) {
    writeJson(res, 404, { error: 'Not found' });
    return;
  }
  await respondWithAgentResult(req, res, onEvent);
}

export class WebhookTriggerAdapter implements TriggerAdapter<http.ServerResponse> {
  public readonly type = 'webhook';

  constructor(private readonly options: WebhookTriggerAdapterOptions = {}) {}

  public listen(
    agent: RunnableAgent,
    onEvent: WebhookOnEvent
  ): WebhookTriggerHandle {
    const path = this.options.path ?? '/';

    const server = http.createServer((req, res) => {
      void handleWebhookRequest(req, res, path, onEvent);
    });

    server.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0');

    void agent; // available for adapters/callers that want a default onEvent; unused by this adapter's own logic.

    const handle: WebhookTriggerHandle = {
      get port(): number {
        const addr = server.address();
        return typeof addr === 'object' && addr ? addr.port : 0;
      },
      stop: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
    return handle;
  }
}
