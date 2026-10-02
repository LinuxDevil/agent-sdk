/**
 * The Slack channel (LOU-P5): a session per Slack thread (or DM), replies posted
 * in the thread with `chat.postMessage`, approvals as Block Kit buttons. Only
 * `fetch` and Web Crypto: no `node:*` import and no Slack SDK.
 */
import { ConfigurationError } from '../execution/errors';
import { checkSlackSignatureWeb } from '../triggers/slackSignature';
import { decodeApprovalRef, encodeApprovalRef, mayApprove, reportChannelError, type Approvers } from './channelSupport';
import {
  defineChannel,
  type Channel,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelUser,
} from './defineChannel';
import { SDKError } from '../execution/errors';

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
  /**
   * Who may click Approve / Deny: Slack user ids (`U...`), or a function
   * `(user, { toolName, input, sessionId })`. Default: only the user who started the
   * turn. Anyone else gets an ephemeral "not allowed" message and the approval stays pending.
   */
  approvers?: Approvers;
  /** Failures after the request was acknowledged (reply delivery, the turn, an approval). Default: `console.error`. */
  onError?: ChannelErrorHandler;
}

/** A Slack `app_mention` or `message` event, as `slackChannel()` reads it. */
export interface SlackChannelEvent {
  type: string;
  channel: string;
  /** `im` for a direct message to the bot. */
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

/** Where a Slack reply goes: the channel and the thread's root `ts` (none in a DM). */
export interface SlackThread {
  channel: string;
  thread_ts?: string;
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
  user?: { id?: string; username?: string; name?: string };
  team?: { id?: string };
  channel?: { id?: string };
  message?: { text?: string; thread_ts?: string };
  response_url?: string;
}

const APPROVE = 'lousho_approve';
const DENY = 'lousho_deny';

function header(req: ChannelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The session key of a thread, or of a whole DM when there is no thread. */
function threadKey(team: string | undefined, channel: string, thread: string | undefined): string {
  return `${team}:${channel}${thread ? `:${thread}` : ''}`;
}

/** The event's session key, text without the bot mention, and whether it mentions the bot; undefined for events to skip. */
function readEvent(envelope: SlackEnvelope): { key: string; text: string; mentioned: boolean; dm: boolean; event: SlackChannelEvent } | undefined {
  const event = envelope.event;
  const botUser = envelope.authorizations?.[0]?.user_id;
  if (envelope.type !== 'event_callback' || !event?.text || event.bot_id || event.subtype || event.user === botUser) return undefined;
  const mention = `<@${botUser}>`;
  const mentioned = event.type === 'app_mention' || (botUser !== undefined && event.text.includes(mention));
  const text = event.text.split(mention).join('').trim();
  const dm = event.channel_type === 'im';
  return { key: threadKey(envelope.team_id, event.channel, dm ? undefined : (event.thread_ts ?? event.ts)), text, mentioned, dm, event };
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
 * messages in a thread that already has a session continue it without a
 * mention (the session store tells, so this survives a restart). A direct
 * message to the bot (`message.im`) is a session of its own per DM channel.
 * Bot messages and Slack retries (`X-Slack-Retry-Num`) are acknowledged and
 * skipped. A tool approval is posted as Approve / Deny buttons that only
 * `approvers` (default: the user who asked) can use, and the message is
 * updated with the outcome; an `ask_question` as text, answered by the next
 * message in the thread.
 *
 * @example
 * ```ts
 * import { slackChannel } from '@lousho/build-ai-agent';
 *
 * const slack = slackChannel({
 *   signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
 *   botToken: process.env.SLACK_BOT_TOKEN ?? '',
 *   approvers: ['U012AB3CD'],
 * });
 * ```
 */
export function slackChannel(options: SlackChannelOptions): Channel<SlackChannelEvent> {
  if (!options.signingSecret || !options.botToken) {
    throw new ConfigurationError('slackChannel: signingSecret and botToken must be non-empty strings.', options.signingSecret ? 'botToken' : 'signingSecret');
  }
  const name = options.name ?? 'slack';
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const questions = new Map<string, string>();

  async function post(thread: unknown, message: Record<string, unknown>): Promise<void> {
    const res = await doFetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${options.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ...(thread as SlackThread), ...message }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new SDKError(`slackChannel: chat.postMessage failed: ${body.error ?? res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }

  /** Answers a click through its `response_url` (an ephemeral note, or the clicked message replaced); a failure goes to `onError`. */
  async function respondTo(url: string | undefined, body: Record<string, unknown>): Promise<void> {
    try {
      const res = url ? await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) : undefined;
      if (res && !res.ok) throw new SDKError(`slackChannel: response_url failed: ${res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    } catch (error) {
      await reportChannelError(options.onError, error, { channel: name, stage: 'reply' });
    }
  }

  /** The Approve / Deny click in an interactivity payload (`payload=<json>`) as a decision, if its user may decide. */
  async function readClick(text: string, ctx: ChannelContext): Promise<ChannelDecision | null> {
    const payload = JSON.parse(new URLSearchParams(text).get('payload') ?? '{}') as SlackInteraction;
    const action = payload.type === 'block_actions' ? payload.actions?.find((a) => a.action_id === APPROVE || a.action_id === DENY) : undefined;
    if (!action?.value) return null;
    const ref = decodeApprovalRef(action.value);
    const approved = action.action_id === APPROVE;
    const user: ChannelUser | undefined = payload.user?.id ? { id: payload.user.id, name: payload.user.username ?? payload.user.name } : undefined;
    const channel = payload.channel?.id;
    const thread = payload.message?.thread_ts;
    const sessionKey = channel ? threadKey(payload.team?.id, channel, thread) : '';
    if (!(await mayApprove(options.approvers, user, ref, ctx, sessionKey))) {
      await respondTo(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: 'You are not allowed to approve this request.' });
      return null;
    }
    const outcome = `${approved ? 'Approved' : 'Denied'} by <@${user?.id}>.`;
    await respondTo(payload.response_url, { replace_original: true, text: `${payload.message?.text ?? ''}\n${outcome}`.trim() });
    const inbound = channel ? { sessionKey, input: '', replyTo: { channel, thread_ts: thread } } : undefined;
    return { decision: { id: ref.id, approved }, inbound, approver: user };
  }

  async function toInbound(envelope: SlackEnvelope, ctx: ChannelContext): Promise<ChannelInbound<SlackChannelEvent> | ChannelDecision | null> {
    const read = readEvent(envelope);
    if (!read || (!read.dm && !(read.mentioned || (read.event.thread_ts && (await ctx.hasSession(read.key)))))) return null;
    if (read.event.type === 'message' && read.mentioned && !read.dm) return null; // the app_mention event runs it
    const question = questions.get(read.key);
    questions.delete(read.key);
    if (question) return { decision: { id: question, answer: read.text } };
    const thread: SlackThread = { channel: read.event.channel, ...(read.dm ? {} : { thread_ts: read.event.thread_ts ?? read.event.ts }) };
    return { sessionKey: read.key, input: read.text, replyTo: thread, event: read.event, metadata: { user: read.event.user } };
  }

  return defineChannel<SlackChannelEvent>({
    name,
    onError: options.onError,
    async verify(req) {
      const reason = await checkSlackSignatureWeb(options.signingSecret, header(req, 'x-slack-request-timestamp'), header(req, 'x-slack-signature'), req.rawBody);
      return { ok: reason === undefined, reason };
    },
    async parse(req, respond, ctx) {
      if (header(req, 'x-slack-retry-num') !== undefined) return null;
      if (header(req, 'content-type')?.startsWith('application/x-www-form-urlencoded')) {
        respond(200, { ok: true });
        return readClick(req.text, ctx);
      }
      const envelope = JSON.parse(req.text || '{}') as SlackEnvelope;
      respond(200, envelope.type === 'url_verification' ? { challenge: envelope.challenge } : { ok: true });
      return toInbound(envelope, ctx);
    },
    reply: ({ inbound, text }) => post(inbound.replyTo, { text }),
    async onApproval({ inbound, approval, text }) {
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        return post(inbound.replyTo, { text });
      }
      const prompt = `Approve \`${approval.toolName}\` with \`${JSON.stringify(approval.args)}\`?`;
      const value = encodeApprovalRef(inbound.metadata?.user, approval.id);
      return post(inbound.replyTo, {
        text: prompt,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: prompt } },
          { type: 'actions', elements: [button('Approve', APPROVE, 'primary', value), button('Deny', DENY, 'danger', value)] },
        ],
      });
    },
  });
}
