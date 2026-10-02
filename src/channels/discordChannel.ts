/**
 * The Discord channel (LOU-P6): slash-command interactions over Discord's HTTP
 * Interactions endpoint (no gateway, no websocket). Only `fetch` and Web
 * Crypto (Ed25519): no `node:*` import and no Discord library.
 */
import { ConfigurationError } from '../execution/errors';
import { decodeApprovalRef, encodeApprovalRef, mayApprove, type Approvers, splitText } from './channelSupport';
import {
  defineChannel,
  type Channel,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelRespond,
} from './defineChannel';
import { SDKError } from '../execution/errors';

/** Options of {@link discordChannel}. */
export interface DiscordChannelOptions {
  /** The application's public key (Developer Portal > General Information), 64 hex characters. */
  publicKey: string;
  /** The application id, used in the interaction webhook URLs. */
  applicationId: string;
  /** Reserved for bot REST calls (e.g. registering commands); replies use the interaction token and need no bot token. */
  botToken?: string;
  /** Route segment. Default `discord`. */
  name?: string;
  /** The `fetch` used for the Discord API (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Who may click Approve / Deny: Discord user ids (snowflakes), or a function
   * `(user, { toolName, input, sessionId })` (`user.roles` has the member's role ids). Default:
   * only the user who ran the command. Anyone else gets an ephemeral "not allowed" reply and
   * the approval stays pending.
   */
  approvers?: Approvers;
  /** Failures after the interaction was acknowledged (reply delivery, the turn, an approval). Default: `console.error`. */
  onError?: ChannelErrorHandler;
}

/** A Discord interaction (slash command or button click), as `discordChannel()` reads it. */
export interface DiscordInteraction {
  type: number;
  id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string; type?: number; parent_id?: string };
  member?: { user?: { id?: string; username?: string }; roles?: string[] };
  user?: { id?: string; username?: string };
  message?: { content?: string };
  data?: { name?: string; custom_id?: string; options?: Array<{ name: string; type: number; value?: unknown }> };
}

/** Where a Discord reply goes: the interaction token, and whether the original response was already edited. */
export interface DiscordTarget {
  token: string;
  edited: boolean;
}

const API = 'https://discord.com/api/v10';
const APPROVE = 'lousho_approve:';
const DENY = 'lousho_deny:';
const MAX_LENGTH = 2000;
const NOT_ALLOWED = 'You are not allowed to approve this request.';
const THREAD_TYPES = new Set([10, 11, 12]);

function header(req: ChannelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  return /^([0-9a-f]{2})+$/i.test(hex) ? new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16))) : undefined;
}

/** A short reason when `signature` is not Ed25519 over `timestamp + rawBody` by `key`, else undefined. */
async function checkSignature(key: Promise<CryptoKey>, timestamp: string | undefined, signature: string | undefined, rawBody: Uint8Array): Promise<string | undefined> {
  const bytes = signature === undefined ? undefined : fromHex(signature);
  if (timestamp === undefined || !bytes) return 'missing or malformed signature headers';
  const prefix = new TextEncoder().encode(timestamp);
  const data = new Uint8Array(prefix.length + rawBody.length);
  data.set(prefix);
  data.set(rawBody, prefix.length);
  return (await crypto.subtle.verify('Ed25519', await key, bytes, data)) ? undefined : 'signature mismatch';
}

/** The slash command's prompt: its `prompt` option, else its first string option. */
function readPrompt(interaction: DiscordInteraction): string {
  const strings = (interaction.data?.options ?? []).filter((option) => option.type === 3 && typeof option.value === 'string');
  return String((strings.find((option) => option.name === 'prompt') ?? strings[0])?.value ?? '').trim();
}

/** The conversation of an interaction: guild + channel (+ the thread when the channel is one). */
function sessionKey(interaction: DiscordInteraction): string {
  const channel = interaction.channel;
  const id = channel?.id ?? interaction.channel_id ?? 'unknown';
  const thread = channel?.type !== undefined && THREAD_TYPES.has(channel.type);
  return [interaction.guild_id ?? 'dm', thread && channel?.parent_id ? channel.parent_id : id, ...(thread && channel?.parent_id ? [id] : [])].join(':');
}

function button(label: string, customId: string, style: number) {
  return { type: 2, style, label, custom_id: customId };
}

/**
 * A Discord application channel. Set the application's Interactions Endpoint
 * URL to `<origin>/channels/discord` and register a slash command with one
 * string option, e.g. `/ask prompt:<text>` (the `prompt` option, or the first
 * string option, is the message). Every request's Ed25519 signature is checked
 * (401 otherwise); `PING` is answered with `PONG`; a command is acknowledged at
 * once with a deferred response (so Discord's 3-second limit holds), the turn
 * runs, and its reply edits the original response (longer than 2000
 * characters: continued in follow-up messages). Commands in the same channel
 * (or thread) share one session. A tool approval is posted with Approve / Deny
 * buttons that only `approvers` (default: the user who ran the command) can use;
 * a click names the conversation itself, so it works after a restart. An `ask_question` as text, answered by the next command in that
 * channel. Interaction tokens last 15 minutes, which bounds a reply's delay.
 *
 * @example
 * ```ts
 * import { discordChannel } from '@lousho/build-ai-agent';
 *
 * const discord = discordChannel({
 *   publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
 *   applicationId: process.env.DISCORD_APPLICATION_ID ?? '',
 * });
 * ```
 */
export function discordChannel(options: DiscordChannelOptions): Channel<DiscordInteraction> {
  const keyBytes = fromHex(options.publicKey);
  if (keyBytes?.length !== 32 || !options.applicationId) {
    throw new ConfigurationError('discordChannel: publicKey must be 64 hex characters and applicationId non-empty.', keyBytes?.length === 32 ? 'applicationId' : 'publicKey');
  }
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let key: Promise<CryptoKey> | undefined;
  const publicKey = () => (key ??= crypto.subtle.importKey('raw', keyBytes, 'Ed25519', false, ['verify']));
  const questions = new Map<string, string>();

  async function call(method: string, path: string, content: string, components?: unknown[]): Promise<void> {
    const res = await doFetch(`${API}/webhooks/${options.applicationId}/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) }),
    });
    if (!res.ok) throw new SDKError(`discordChannel: ${method} ${path.split('/').slice(1).join('/')} failed: ${res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }

  /** The first message edits the interaction's original response; the rest (and later replies) are follow-ups. */
  async function post(target: DiscordTarget, text: string, components?: unknown[]): Promise<void> {
    for (const [i, part] of splitText(text, MAX_LENGTH).entries()) {
      const attach = i === 0 ? components : undefined;
      if (target.edited) await call('POST', target.token, part, attach);
      else await call('PATCH', `${target.token}/messages/@original`, part, attach);
      target.edited = true;
    }
  }

  async function readCommand(interaction: DiscordInteraction, respond: ChannelRespond, ctx: ChannelContext): Promise<ChannelInbound<DiscordInteraction> | ChannelDecision | null> {
    const input = readPrompt(interaction);
    if (!input || !interaction.token) {
      respond(200, { type: 4, data: { content: 'Usage: /ask prompt:<text>', flags: 64 } });
      return null;
    }
    respond(200, { type: 5 });
    const key = sessionKey(interaction);
    const target: DiscordTarget = { token: interaction.token, edited: false };
    // the next /ask in the channel answers a pending ask_question, also one asked before a restart
    const question = questions.get(key) ?? (await ctx.pendingQuestion(key));
    const user = interaction.member?.user?.id ?? interaction.user?.id;
    const inbound = { sessionKey: key, input, replyTo: target, event: interaction, metadata: { user }, ...(user && { principal: { id: user, type: 'user' as const, authenticator: 'discord' } }) };
    if (!question) return inbound;
    questions.delete(key);
    return { decision: { id: question, answer: input }, inbound }; // the answer's own "thinking" message is the one to edit
  }

  async function readClick(interaction: DiscordInteraction, respond: ChannelRespond, ctx: ChannelContext): Promise<ChannelDecision | null> {
    const customId = interaction.data?.custom_id ?? '';
    const approved = customId.startsWith(APPROVE);
    if (!(approved || customId.startsWith(DENY)) || !interaction.token) return respond(200, { type: 6 }), null;
    const ref = decodeApprovalRef(customId.slice((approved ? APPROVE : DENY).length));
    const key = sessionKey(interaction);
    const raw = interaction.member?.user ?? interaction.user;
    const user = raw?.id ? { id: raw.id, name: raw.username, roles: interaction.member?.roles } : undefined;
    if (!(await mayApprove(options.approvers, user, ref, ctx, key))) return respond(200, { type: 4, data: { content: NOT_ALLOWED, flags: 64 } }), null;
    const content = `${interaction.message?.content ?? ''}\n${approved ? 'Approved' : 'Denied'} by <@${user?.id}>.`.trim().slice(0, MAX_LENGTH);
    respond(200, { type: 7, data: { content, components: [], allowed_mentions: { parse: [] } } });
    // the continuation follows the clicked message, whichever process posted it
    const target: DiscordTarget = { token: interaction.token, edited: true };
    return { decision: { id: ref.id, approved }, inbound: { sessionKey: key, input: '', replyTo: target, event: interaction }, approver: user };
  }

  return defineChannel<DiscordInteraction>({
    name: options.name ?? 'discord',
    onError: options.onError,
    async verify(req) {
      const reason = await checkSignature(publicKey(), header(req, 'x-signature-timestamp'), header(req, 'x-signature-ed25519'), req.rawBody);
      return { ok: reason === undefined, reason };
    },
    async parse(req, respond, ctx) {
      const interaction = JSON.parse(req.text || '{}') as DiscordInteraction;
      if (interaction.type === 1) return respond(200, { type: 1 }), null;
      if (interaction.type === 2) return readCommand(interaction, respond, ctx);
      if (interaction.type === 3) return readClick(interaction, respond, ctx);
      return respond(200, { type: 6 }), null;
    },
    reply: ({ inbound, text }) => post(inbound.replyTo as DiscordTarget, text),
    async onApproval({ inbound, approval, text }) {
      const target = inbound.replyTo as DiscordTarget;
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        return post(target, text);
      }
      const prompt = `Approve \`${approval.toolName}\` with \`${JSON.stringify(approval.args)}\`?`;
      const ref = encodeApprovalRef(inbound.metadata?.user, approval.id);
      const row = { type: 1, components: [button('Approve', APPROVE + ref, 3), button('Deny', DENY + ref, 4)] };
      return post(target, prompt.slice(0, MAX_LENGTH - 100), [row]);
    },
  });
}
