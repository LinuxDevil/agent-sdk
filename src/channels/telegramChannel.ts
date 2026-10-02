/**
 * The Telegram channel (N11a): bot webhooks (`setWebhook` with a secret token)
 * and inline-keyboard approvals. Only `fetch` and Web Crypto: no `node:*`
 * import and no Telegram library.
 */
import { ConfigurationError, SDKError } from '../execution/errors';
import { decodeApprovalRef, encodeApprovalRef, mayApprove, reportChannelError, secretsEqual, type Approvers, splitText, answerPendingQuestion } from './channelSupport';
import {
  defineChannel,
  type Channel,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRespond,
  type ChannelUser,
} from './defineChannel';

/** Options of {@link telegramChannel}. */
export interface TelegramChannelOptions {
  /** The bot token from BotFather; used for `sendMessage`, `answerCallbackQuery` and `editMessageText`. Never logged. */
  botToken: string;
  /** The `secret_token` passed to `setWebhook`; checked (in constant time) on every request. */
  secretToken: string;
  /** The bot's username without `@`; enables `/ask@bot`, `@bot` mentions and replies to the bot in groups. */
  botUsername?: string;
  /** Route segment. Default `telegram`. */
  name?: string;
  /** The `fetch` used for the Bot API (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Who may tap Approve / Deny: Telegram user ids (as strings), or a function
   * `(user, { toolName, input, sessionId })`. Default: only the user who started the turn.
   * Anyone else gets an alert and the approval stays pending.
   */
  approvers?: Approvers;
  /** Failures after the update was acknowledged (reply delivery, the turn, an approval). Default: `console.error`. */
  onError?: ChannelErrorHandler;
}

/** A Telegram user, with only the fields the channel reads. */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

/** A Telegram message, with only the fields the channel reads. */
export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id?: number; from?: TelegramUser };
}

/** A tap on an inline-keyboard button, with only the fields the channel reads. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/** A webhook update, as `telegramChannel()` reads it. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Where a Telegram reply goes. */
export interface TelegramTarget {
  chatId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
}

const API = 'https://api.telegram.org';
const MAX_LENGTH = 4096;
const MAX_CALLBACK_BYTES = 64;
const NOT_ALLOWED = 'You are not allowed to approve this request.';
const COMMAND = '/ask';

const topicOf = (message: TelegramMessage): number | undefined => (message.is_topic_message ? message.message_thread_id : undefined);

/** The conversation of a message: the chat, plus the topic in a forum. */
function sessionKey(message: TelegramMessage): string {
  const topic = topicOf(message);
  return topic === undefined ? String(message.chat.id) : `${message.chat.id}:${topic}`;
}

function targetOf(message: TelegramMessage): TelegramTarget {
  const topic = topicOf(message);
  return { chatId: message.chat.id, ...(topic === undefined ? {} : { messageThreadId: topic }), replyToMessageId: message.message_id };
}

function userOf(from: TelegramUser): ChannelUser {
  return { id: String(from.id), name: from.username ?? from.first_name };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A Telegram bot channel. Create the bot with BotFather, then call `setWebhook`
 * with `url: <origin>/channels/telegram`, a `secret_token` (the same value as
 * `secretToken`) and `allowed_updates: ["message", "callback_query"]`. Every
 * request's `X-Telegram-Bot-Api-Secret-Token` header is compared in constant
 * time (401 otherwise); the update is acknowledged with `200` at once and the
 * turn runs after. In a private chat every text message (or caption) is a
 * message to the agent; in a group only `/ask`, `/ask@<botUsername>`, an
 * `@<botUsername>` mention or a reply to the bot is. One session per chat (per
 * topic in a forum). A tool approval is posted with Approve / Deny buttons that
 * only `approvers` (default: the user who started the turn) can use; the tap
 * names the conversation itself, so it works after a restart. An
 * `ask_question` is posted with `force_reply`, and the next message in the chat
 * is the answer, also after a restart given durable stores. Replies are plain
 * text (no `parse_mode`), split at 4096 characters.
 *
 * @example
 * ```ts
 * import { telegramChannel } from '@lousho/build-ai-agent';
 *
 * const telegram = telegramChannel({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
 *   secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? '',
 *   botUsername: 'my_agent_bot',
 * });
 * ```
 */
export function telegramChannel(options: TelegramChannelOptions): Channel<TelegramUpdate> {
  if (!options.botToken || !options.secretToken) {
    throw new ConfigurationError('telegramChannel: botToken and secretToken must be non-empty strings.', options.botToken ? 'secretToken' : 'botToken');
  }
  const name = options.name ?? 'telegram';
  const botUsername = options.botUsername?.replace(/^@/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const questions = new Map<string, string>();
  const mention = botUsername ? new RegExp(`@${escapeRegExp(botUsername)}(?![A-Za-z0-9_])`, 'gi') : undefined;
  const command = new RegExp(`^${COMMAND}${botUsername ? `(?:@${escapeRegExp(botUsername)})?` : ''}(?![A-Za-z0-9_@])`, 'i');

  /** Calls a Bot API method; the token is part of the URL, so errors name the method and status only. */
  async function call(method: string, params: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(`${API}/bot${options.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    } catch {
      throw new SDKError(`telegramChannel: ${method} failed: the request did not complete`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number };
    if (!res.ok || body.ok !== true) throw new SDKError(`telegramChannel: ${method} failed: ${body.error_code ?? res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }

  async function post(target: TelegramTarget, text: string, replyMarkup?: unknown): Promise<void> {
    for (const [i, part] of splitText(text, MAX_LENGTH).entries()) {
      await call('sendMessage', {
        chat_id: target.chatId,
        ...(target.messageThreadId === undefined ? {} : { message_thread_id: target.messageThreadId }),
        ...(i === 0 && target.replyToMessageId !== undefined ? { reply_parameters: { message_id: target.replyToMessageId, allow_sending_without_reply: true } } : {}),
        text: part,
        ...(i === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  }

  /** A failure answering a tap goes to `onError`; it must not stop the decision. */
  async function best(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await call(method, params);
    } catch (error) {
      await reportChannelError(options.onError, error, { channel: name, stage: 'reply' });
    }
  }

  /** The text a message addresses to the bot (command and mentions stripped), or `undefined` when it is not for the bot. */
  function addressed(message: TelegramMessage, text: string): string | undefined {
    if (message.chat.type === 'private') return text.trim();
    const isCommand = command.test(text);
    const mentioned = mention !== undefined && new RegExp(mention.source, 'i').test(text);
    const reply = message.reply_to_message?.from;
    const repliedToBot = reply?.is_bot === true && (botUsername === undefined || reply.username?.toLowerCase() === botUsername.toLowerCase());
    if (!(isCommand || mentioned || repliedToBot)) return undefined;
    return (mention ? text.replace(mention, ' ') : text).replace(command, '').trim();
  }

  async function readMessage(message: TelegramMessage, update: TelegramUpdate, ctx: ChannelContext): Promise<ChannelInbound<TelegramUpdate> | ChannelDecision | null> {
    if (!message.from || message.from.is_bot) return null;
    const input = addressed(message, message.text ?? message.caption ?? '');
    if (!input) return null;
    const key = sessionKey(message);
    const inbound = { sessionKey: key, input, replyTo: targetOf(message), event: update, metadata: { user: String(message.from.id) }, principal: { id: String(message.from.id), type: 'user' as const, authenticator: 'telegram' } };
    // the next message in the chat answers a pending ask_question, also one asked before a restart
    return answerPendingQuestion(inbound, questions, ctx);
  }

  async function readClick(query: TelegramCallbackQuery, ctx: ChannelContext): Promise<ChannelDecision | null> {
    const approved = query.data?.startsWith('a:') === true;
    const message = query.message;
    if (!query.data || !(approved || query.data.startsWith('d:')) || !message) {
      await best('answerCallbackQuery', { callback_query_id: query.id });
      return null;
    }
    const ref = decodeApprovalRef(query.data.slice(2));
    const key = sessionKey(message);
    const user = userOf(query.from);
    if (!(await mayApprove(options.approvers, user, ref, ctx, key))) {
      await best('answerCallbackQuery', { callback_query_id: query.id, text: NOT_ALLOWED, show_alert: true });
      return null;
    }
    await best('answerCallbackQuery', { callback_query_id: query.id });
    const who = query.from.username ? `@${query.from.username}` : (query.from.first_name ?? String(query.from.id));
    // no reply_markup: the keyboard is removed, so the buttons cannot be tapped again
    await best('editMessageText', { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text ?? ''}\n${approved ? 'Approved' : 'Denied'} by ${who}.`.trim().slice(0, MAX_LENGTH) });
    const inbound = { sessionKey: key, input: '', replyTo: targetOf(message), ...(ref.starter ? { metadata: { user: ref.starter } } : {}) };
    return { decision: { id: ref.id, approved }, inbound, approver: user };
  }

  return defineChannel<TelegramUpdate>({
    name,
    onError: options.onError,
    async verify(req) {
      const sent = req.headers['x-telegram-bot-api-secret-token'];
      if (typeof sent !== 'string') return { ok: false, reason: 'missing secret token header' };
      return (await secretsEqual(sent, options.secretToken)) ? { ok: true } : { ok: false, reason: 'secret token mismatch' };
    },
    async parse(req, respond: ChannelRespond, ctx) {
      respond(200, { ok: true }); // Telegram retries a webhook that does not answer quickly
      const update = JSON.parse(req.text || '{}') as TelegramUpdate;
      if (update.callback_query) return readClick(update.callback_query, ctx);
      return update.message ? readMessage(update.message, update, ctx) : null;
    },
    reply: ({ inbound, text }) => post(inbound.replyTo as TelegramTarget, text),
    async onApproval({ inbound, approval, text }) {
      const target = inbound.replyTo as TelegramTarget;
      // N9b: a sign-in is its link as text, no Approve / Deny keyboard (Telegram has no message only one user sees).
      if (approval.kind === 'sign-in') return post(target, text);
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        return post(target, text, { force_reply: true });
      }
      const prompt = `Approve \`${approval.toolName}\` with \`${JSON.stringify(approval.args)}\`?`;
      let ref = encodeApprovalRef(inbound.metadata?.user, approval.id);
      // callback_data is limited to 64 bytes: without room for the starter, only a list or function of approvers can approve
      if (new TextEncoder().encode(`a:${ref}`).length > MAX_CALLBACK_BYTES) ref = encodeApprovalRef(undefined, approval.id);
      const keyboard = { inline_keyboard: [[{ text: 'Approve', callback_data: `a:${ref}` }, { text: 'Deny', callback_data: `d:${ref}` }]] };
      return post(target, prompt.slice(0, MAX_LENGTH - 100), keyboard);
    },
  });
}
