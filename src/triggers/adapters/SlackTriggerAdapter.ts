/**
 * Slack trigger adapter (LOU-T5).
 *
 * Generalizes examples/slack-notifier's ad hoc pattern (build an agent,
 * call `.send()` on a raw event description, print/post the text) into a
 * real, reusable adapter: a Slack message event comes in via
 * `handleEvent()`, runs the agent, and posts the reply back to the
 * originating channel.
 *
 * ## Why this does NOT reuse src/tools/built-in/slack.ts's transport
 *
 * `createSlackTool()`/`postSlackAlert()` in src/tools/built-in/slack.ts is
 * purpose-built for one specific shape: an ALERT with a "Fix it" Block Kit
 * button whose `value` is a REQUIRED `approvalId` that resumes a pending
 * LOU-C approval (see that file's doc comment). Every payload it can build
 * carries that button. A generic trigger reply has no `approvalId` and no
 * "Fix it" action to attach - forcing one through `buildSlackAlertPayload()`
 * would mean fabricating a meaningless approvalId just to satisfy its
 * shape, which would be actively misleading (a real "Fix it" button that
 * doesn't resume anything). So this adapter posts its own minimal
 * `{channel, text}` payload to the same kind of Incoming Webhook URL
 * instead, reusing only the `SLACK_WEBHOOK_URL_ENV_KEY` env var convention
 * (and its default-source-of-the-URL behavior) for consistency, not the
 * alert-shaped payload builder itself.
 */
import type { ExecutionResult } from '../../execution/AgentExecutor';
import { SLACK_WEBHOOK_URL_ENV_KEY } from '../../tools/built-in/slack';
import { Logger, noopLogger } from '../../execution/logger';
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';
import { checkSlackSignature } from '../webhookAuth';
import { SDKError } from '../../execution/errors';

export interface SlackMessageEvent {
  channel: string;
  text: string;
}

export interface SlackTriggerAdapterOptions {
  /** Overrides SLACK_WEBHOOK_URL for testing/injection. */
  webhookUrl?: string;
  /** Overrides the fetch implementation used to POST replies (testing). */
  fetchImpl?: typeof fetch;
  /**
   * Your Slack app's signing secret. When set, `handleRequest()` verifies every
   * inbound request (HMAC-SHA256 over `v0:{timestamp}:{raw body}`, five-minute
   * replay window) and answers a generic 401 otherwise. **Set it for any
   * endpoint reachable from outside your machine**: without it anyone who can
   * reach the endpoint can run your agent.
   *
   * @example
   * ```ts
   * new SlackTriggerAdapter({ signingSecret: process.env.SLACK_SIGNING_SECRET });
   * ```
   */
  signingSecret?: string;
  /** Receives signature failures and the "no signingSecret" warning. Defaults to a no-op logger. */
  logger?: Logger;
}

/** A raw inbound Slack HTTP request, as handed to {@link SlackTriggerAdapter.handleRequest}. */
export interface SlackInboundRequest {
  /** Request headers (Node's `req.headers` works as is). */
  headers: Record<string, string | string[] | undefined>;
  /** The exact body bytes received. Do not re-serialize a parsed body: the signature covers the raw bytes. */
  rawBody: Buffer | string;
}

/** What your HTTP handler should send back to Slack. */
export interface SlackHttpResponse {
  status: number;
  body: Record<string, unknown>;
}

function headerValue(headers: SlackInboundRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseJsonObject(raw: Buffer | string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `{ channel, text }` of a plain user message in an Events API `event_callback`, if the payload is one. */
function extractMessageEvent(payload: Record<string, unknown>): SlackMessageEvent | undefined {
  const event = payload.event as Record<string, unknown> | undefined;
  if (payload.type !== 'event_callback' || event?.type !== 'message') return undefined;
  if (event.subtype !== undefined || event.bot_id !== undefined) return undefined;
  if (typeof event.channel !== 'string' || typeof event.text !== 'string') return undefined;
  return { channel: event.channel, text: event.text };
}

export class SlackTriggerAdapter implements TriggerAdapter<string> {
  public readonly type = 'slack';

  private onEventHandler?: (input: string, context: TriggerContext) => Promise<ExecutionResult>;
  private listening = false;
  private warnedUnauthenticated = false;

  constructor(private readonly options: SlackTriggerAdapterOptions = {}) {}

  public listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle {
    void agent;
    this.onEventHandler = onEvent;
    this.listening = true;
    this.warnIfUnauthenticated();

    return {
      stop: () => {
        this.listening = false;
        this.onEventHandler = undefined;
      },
    };
  }

  private warnIfUnauthenticated(): void {
    if (this.options.signingSecret || this.warnedUnauthenticated) return;
    this.warnedUnauthenticated = true;
    (this.options.logger ?? noopLogger).warn(
      'SlackTriggerAdapter has no `signingSecret`: Slack request signatures are not verified, so anyone who can reach ' +
        'your endpoint can run your agent. Pass options.signingSecret; see docs/api-overview.md#slack-request-signatures.'
    );
  }

  /**
   * Handles a raw Slack Events API HTTP request and returns the response to send.
   * With `signingSecret` set, the signature is verified against the raw body
   * before anything is parsed (so the signed `url_verification` handshake works
   * too); failures get a generic 401 and are logged without secrets or signatures.
   *
   * @example
   * ```ts
   * const { status, body } = await adapter.handleRequest({ headers: req.headers, rawBody });
   * res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
   * ```
   */
  public async handleRequest(request: SlackInboundRequest): Promise<SlackHttpResponse> {
    const { signingSecret } = this.options;
    if (signingSecret) {
      // Scheme: https://docs.slack.dev/authentication/verifying-requests-from-slack
      const failure = checkSlackSignature({
        signingSecret,
        timestamp: headerValue(request.headers, 'x-slack-request-timestamp'),
        signature: headerValue(request.headers, 'x-slack-signature'),
        rawBody: request.rawBody,
      });
      if (failure !== undefined) {
        (this.options.logger ?? noopLogger).warn('slack request rejected: signature verification failed', { reason: failure });
        return { status: 401, body: { error: 'Unauthorized' } };
      }
    }
    const payload = parseJsonObject(request.rawBody);
    if (!payload) return { status: 400, body: { error: 'Invalid JSON body' } };
    if (payload.type === 'url_verification') return { status: 200, body: { challenge: payload.challenge } };
    const event = extractMessageEvent(payload);
    if (event) await this.handleEvent(event);
    return { status: 200, body: { ok: true } };
  }

  /**
   * Feeds a Slack message event into the adapter (called by whatever is
   * actually subscribed to Slack - an Events API HTTP endpoint, a Socket
   * Mode client, a test, ...). Runs the agent via the `onEvent` callback
   * given to `listen()`, then posts the result's text back to the event's
   * channel via `reply()`. No-ops (returns undefined) if `listen()` hasn't
   * been called yet or has since been `stop()`-ped.
   */
  public async handleEvent(event: SlackMessageEvent): Promise<ExecutionResult | undefined> {
    if (!this.listening || !this.onEventHandler) {
      return undefined;
    }
    const result = await this.onEventHandler(event.text, { channel: event.channel });
    await this.reply(event.channel, result.text);
    return result;
  }

  private resolveWebhookUrl(): string {
    const webhookUrl = this.options.webhookUrl ?? process.env[SLACK_WEBHOOK_URL_ENV_KEY];
    if (!webhookUrl) {
      throw new SDKError(
        `SlackTriggerAdapter: no webhook URL configured. Set ${SLACK_WEBHOOK_URL_ENV_KEY} or pass options.webhookUrl.`,
        'LOUSHO_TRIGGER_INVALID'
      );
    }
    return webhookUrl;
  }

  public async reply(channel: string, message: string): Promise<void> {
    const webhookUrl = this.resolveWebhookUrl();

    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: message }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new SDKError(`SlackTriggerAdapter: reply post failed: ${response.statusText} - ${errorText}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    }
  }
}
