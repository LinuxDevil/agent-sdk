/**
 * The Slack channel (LOU-P5): a session per Slack thread, replies posted in
 * the thread with `chat.postMessage`, approvals as Block Kit buttons. Only
 * `fetch` and Web Crypto: no `node:*` import and no Slack SDK.
 */
import { ConfigurationError } from '../execution/errors';
import { checkSlackSignatureWeb } from '../triggers/slackSignature';
import { defineChannel, type Channel, type ChannelDecision, type ChannelInbound, type ChannelRequest } from './defineChannel';

/** Options of {@link slackChannel}. */
export interface SlackChannelOptions {
  /** The app's signing secret (Basic Information > App Credentials). */
  signingSecret: string;
  /** The bot token (`xoxb-...`) used for `chat.postMessage`. */
  botToken: string;
  /** Route segment. Default `slack`. */
  name?: string;
  /** The `fetch` used for the Slack Web API (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** A Slack `app_mention` or `message` event, as `slackChannel()` reads it. */
export interface SlackChannelEvent {
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

/** Where a Slack reply goes: the channel and the thread's root `ts`. */
export interface SlackThread {
  channel: string;
  thread_ts: string;
}

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackChannelEvent;
  authorizations?: Array<{ user_id?: string }>;
}

interface SlackInteraction {
  type?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

const APPROVE = 'loushy_approve';
const DENY = 'loushy_deny';

function header(req: ChannelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The Approve / Deny click in an interactivity payload (`payload=<json>`), as a decision. */
function parseInteraction(text: string): ChannelDecision | null {
  const payload = JSON.parse(new URLSearchParams(text).get('payload') ?? '{}') as SlackInteraction;
  const action = payload.type === 'block_actions' ? payload.actions?.find((a) => a.action_id === APPROVE || a.action_id === DENY) : undefined;
  return action?.value ? { decision: { id: action.value, approved: action.action_id === APPROVE } } : null;
}

/** The event's thread key, text without the bot mention, and whether it mentions the bot; undefined for events to skip. */
function readEvent(envelope: SlackEnvelope): { key: string; text: string; mentioned: boolean; event: SlackChannelEvent } | undefined {
  const event = envelope.event;
  const botUser = envelope.authorizations?.[0]?.user_id;
  if (envelope.type !== 'event_callback' || !event?.text || event.bot_id || event.subtype || event.user === botUser) return undefined;
  const mention = `<@${botUser}>`;
  const mentioned = event.type === 'app_mention' || (botUser !== undefined && event.text.includes(mention));
  const text = event.text.split(mention).join('').trim();
  return { key: `${envelope.team_id}:${event.channel}:${event.thread_ts ?? event.ts}`, text, mentioned, event };
}

function button(text: string, actionId: string, style: string, value: string) {
  return { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, style, value };
}

/**
 * A Slack app channel. Point the app's Event Subscriptions and Interactivity
 * Request URLs at `POST <basePath>/slack`. Each request's signature is checked
 * (401 otherwise) and answered at once, so Slack's 3-second limit holds; the
 * turn then runs and posts its reply in the thread. A mention starts or
 * continues the session of its thread (`team:channel:thread_ts`); later
 * messages in a thread the bot was mentioned in (since this process started)
 * continue it without a mention. Bot messages and Slack retries
 * (`X-Slack-Retry-Num`) are acknowledged and skipped. A tool approval is posted
 * as Approve / Deny buttons; an `ask_question` as text, answered by the next
 * message in the thread.
 *
 * @example
 * ```ts
 * import { slackChannel } from '@loushy/build-ai-agent';
 *
 * const slack = slackChannel({
 *   signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
 *   botToken: process.env.SLACK_BOT_TOKEN ?? '',
 * });
 * ```
 */
export function slackChannel(options: SlackChannelOptions): Channel<SlackChannelEvent> {
  if (!options.signingSecret || !options.botToken) {
    throw new ConfigurationError('slackChannel: signingSecret and botToken must be non-empty strings.', options.signingSecret ? 'botToken' : 'signingSecret');
  }
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const threads = new Set<string>();
  const questions = new Map<string, string>();

  async function post(thread: unknown, message: Record<string, unknown>): Promise<void> {
    const res = await doFetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${options.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ...(thread as SlackThread), ...message }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new Error(`slackChannel: chat.postMessage failed: ${body.error ?? res.status}`);
  }

  function toInbound(envelope: SlackEnvelope): ChannelInbound<SlackChannelEvent> | ChannelDecision | null {
    const read = readEvent(envelope);
    if (!read || !(read.mentioned || (read.event.thread_ts && threads.has(read.key)))) return null;
    if (read.event.type === 'message' && read.mentioned) return null; // the app_mention event runs it
    threads.add(read.key);
    const question = questions.get(read.key);
    questions.delete(read.key);
    if (question) return { decision: { id: question, answer: read.text } };
    const thread: SlackThread = { channel: read.event.channel, thread_ts: read.event.thread_ts ?? read.event.ts };
    return { sessionKey: read.key, input: read.text, replyTo: thread, event: read.event, metadata: { user: read.event.user } };
  }

  return defineChannel<SlackChannelEvent>({
    name: options.name ?? 'slack',
    async verify(req) {
      const reason = await checkSlackSignatureWeb(options.signingSecret, header(req, 'x-slack-request-timestamp'), header(req, 'x-slack-signature'), req.rawBody);
      return { ok: reason === undefined, reason };
    },
    async parse(req, respond) {
      if (header(req, 'x-slack-retry-num') !== undefined) return null;
      if (header(req, 'content-type')?.startsWith('application/x-www-form-urlencoded')) {
        respond(200, { ok: true });
        return parseInteraction(req.text);
      }
      const envelope = JSON.parse(req.text || '{}') as SlackEnvelope;
      respond(200, envelope.type === 'url_verification' ? { challenge: envelope.challenge } : { ok: true });
      return toInbound(envelope);
    },
    reply: ({ inbound, text }) => post(inbound.replyTo, { text }),
    async onApproval({ inbound, approval, text }) {
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        return post(inbound.replyTo, { text });
      }
      const prompt = `Approve \`${approval.toolName}\` with \`${JSON.stringify(approval.args)}\`?`;
      return post(inbound.replyTo, {
        text: prompt,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: prompt } },
          { type: 'actions', elements: [button('Approve', APPROVE, 'primary', approval.id), button('Deny', DENY, 'danger', approval.id)] },
        ],
      });
    },
  });
}
