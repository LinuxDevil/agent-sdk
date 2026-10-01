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
 *
 * Authentication (LOU-D13): `options.auth` verifies every request (HMAC over
 * the raw body, bearer token, or a custom verifier) before the agent runs.
 *
 * LOU-P7: auth and input parsing are `webhookChannel()`'s (src/channels),
 * which this adapter delegates to; it keeps its own server and response.
 */
import * as http from 'node:http';
import type { ExecutionResult } from '../../execution/AgentExecutor';
import { Logger, noopLogger } from '../../execution/logger';
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';
import type { WebhookAuth } from '../webhookAuth';
import { toChannelRequest } from '../../channels/defineChannel';
import { webhookChannel, type WebhookChannel } from '../../channels/webhookChannel';

export interface WebhookTriggerAdapterOptions {
  /** Port to listen on. Defaults to 0 (OS-assigned ephemeral port - inspect `handle.port` after `listen()`). */
  port?: number;
  /** Host to bind to. Defaults to '0.0.0.0'. */
  host?: string;
  /** Only requests to this path are handled; everything else gets a 404. Defaults to '/'. */
  path?: string;
  /**
   * Authenticate every request (HMAC signature over the raw body, bearer
   * token, or a custom verifier). Failures get a generic `401`. Strongly
   * recommended for any webhook reachable from outside your machine.
   *
   * @example
   * ```ts
   * new WebhookTriggerAdapter({
   *   auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET ?? '' },
   * });
   * ```
   */
  auth?: WebhookAuth;
  /** Receives auth failures and the "no auth configured" warning. Defaults to a no-op logger. */
  logger?: Logger;
}

export interface WebhookTriggerHandle extends TriggerHandle {
  /** The actual port the server bound to (useful when `options.port` was 0/omitted). */
  readonly port: number;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

type WebhookOnEvent = (input: string, context: TriggerContext) => Promise<ExecutionResult>;

interface WebhookRuntime {
  path: string;
  onEvent: WebhookOnEvent;
  channel: WebhookChannel;
  logger: Logger;
}

async function respondWithAgentResult(
  runtime: WebhookRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const request = toChannelRequest(req, await readBody(req));
    const { ok, reason } = await runtime.channel.verify(request);
    if (!ok) {
      runtime.logger.warn('webhook request rejected: authentication failed', { reason, remoteAddress: req.socket.remoteAddress });
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const inbound = await runtime.channel.parse(request);
    const input = typeof inbound?.input === 'string' ? inbound.input : '';
    const result = await runtime.onEvent(input, { channel: res, request: req });
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, 500, { error: (error as Error).message });
  }
}

async function handleWebhookRequest(
  runtime: WebhookRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'POST' || req.url !== runtime.path) {
    writeJson(res, 404, { error: 'Not found' });
    return;
  }
  await respondWithAgentResult(runtime, req, res);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

export class WebhookTriggerAdapter implements TriggerAdapter<http.ServerResponse> {
  public readonly type = 'webhook';

  private warnedUnauthenticated = false;

  private readonly channel: WebhookChannel;

  constructor(private readonly options: WebhookTriggerAdapterOptions = {}) {
    this.channel = webhookChannel({ auth: options.auth });
  }

  private warnIfUnauthenticated(host: string, logger: Logger): void {
    if (this.options.auth || this.warnedUnauthenticated || isLoopbackHost(host)) return;
    this.warnedUnauthenticated = true;
    logger.warn(
      `WebhookTriggerAdapter is listening on ${host} without \`auth\`: anyone who can reach it can run your agent. ` +
        'Configure options.auth (hmac, bearer or custom); see docs/api-overview.md#triggers.'
    );
  }

  public listen(
    agent: RunnableAgent,
    onEvent: WebhookOnEvent
  ): WebhookTriggerHandle {
    const host = this.options.host ?? '0.0.0.0';
    const logger = this.options.logger ?? noopLogger;
    const runtime: WebhookRuntime = { path: this.options.path ?? '/', onEvent, channel: this.channel, logger };
    this.warnIfUnauthenticated(host, logger);

    const server = http.createServer((req, res) => {
      void handleWebhookRequest(runtime, req, res);
    });

    server.listen(this.options.port ?? 0, host);

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
