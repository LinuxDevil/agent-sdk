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
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';

export interface SlackMessageEvent {
  channel: string;
  text: string;
}

export interface SlackTriggerAdapterOptions {
  /** Overrides SLACK_WEBHOOK_URL for testing/injection. */
  webhookUrl?: string;
  /** Overrides the fetch implementation used to POST replies (testing). */
  fetchImpl?: typeof fetch;
}

export class SlackTriggerAdapter implements TriggerAdapter<string> {
  public readonly type = 'slack';

  private onEventHandler?: (input: string, context: TriggerContext) => Promise<ExecutionResult>;
  private listening = false;

  constructor(private readonly options: SlackTriggerAdapterOptions = {}) {}

  public listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle {
    void agent;
    this.onEventHandler = onEvent;
    this.listening = true;

    return {
      stop: () => {
        this.listening = false;
        this.onEventHandler = undefined;
      },
    };
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
      throw new Error(
        `SlackTriggerAdapter: no webhook URL configured. Set ${SLACK_WEBHOOK_URL_ENV_KEY} or pass options.webhookUrl.`
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
      throw new Error(`SlackTriggerAdapter: reply post failed: ${response.statusText} - ${errorText}`);
    }
  }
}
