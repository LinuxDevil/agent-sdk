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

export class WebhookTriggerAdapter implements TriggerAdapter<http.ServerResponse> {
  public readonly type = 'webhook';

  constructor(private readonly options: WebhookTriggerAdapterOptions = {}) {}

  public listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): WebhookTriggerHandle {
    const path = this.options.path ?? '/';

    const server = http.createServer((req, res) => {
      void (async () => {
        if (req.method !== 'POST' || req.url !== path) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ error: 'Not found' })
          );
          return;
        }
        try {
          const raw = await readBody(req);
          let input: string;
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as { input?: unknown };
              input = typeof parsed.input === 'string' ? parsed.input : raw;
            } catch {
              input = raw;
            }
          } else {
            input = '';
          }

          const result = await onEvent(input, { channel: res, request: req });
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) {
          res
            .writeHead(500, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: (error as Error).message }));
        }
      })();
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
