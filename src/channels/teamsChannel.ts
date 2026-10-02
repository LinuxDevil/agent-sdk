/**
 * The Microsoft Teams channel (N11c): Azure Bot messages (personal chats, group
 * chats and channel mentions) and Adaptive Card approvals. The inbound Bot
 * Framework JWT is verified by the auth module's `oidc()` (`verifyJwt()` and a
 * cached `jwksKeySource()`); replies go through the Bot Framework Connector with
 * `fetch`. Web Crypto and `fetch` only: no `node:*` import and no Bot Framework library.
 */
import { oidc } from '../auth/oidc';
import { ConfigurationError, SDKError } from '../execution/errors';
import { decodeApprovalRef, encodeApprovalRef, mayApprove, reportChannelError, type ApprovalRef, type Approvers, splitText, answerPendingQuestion } from './channelSupport';
import {
  defineChannel,
  type Channel,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelRespond,
  type ChannelUser,
} from './defineChannel';

/** Options of {@link teamsChannel}. */
export interface TeamsChannelOptions {
  /** The Azure Bot's Microsoft App ID. It is the audience every inbound token must carry. */
  appId: string;
  /** The bot's client secret, for outbound Connector calls only. Never logged, never put in an error. */
  appPassword: string;
  /** The Entra tenant of a single-tenant bot. Default: a multi-tenant bot (`botframework.com`). */
  tenantId?: string;
  /** Route segment. Default `teams`. */
  name?: string;
  /** The `fetch` used for the OpenID metadata, the key set, the token endpoint and the Connector (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Who may press Approve / Deny: Teams user ids (`from.id`, such as `29:1abc...`), or a function
   * `(user, { toolName, input, sessionId })`. Default: only the user who started the turn.
   * Anyone else is told so and the approval stays pending.
   */
  approvers?: Approvers;
  /** Failures after the activity was acknowledged (reply delivery, the turn, an approval). Default: `console.error`. */
  onError?: ChannelErrorHandler;
}

/** A Bot Framework activity, with only the fields the channel reads. */
export interface TeamsActivity {
  type: string;
  id: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  recipient: { id: string; name?: string };
  conversation: { id: string; conversationType?: 'personal' | 'groupChat' | 'channel'; tenantId?: string };
  text?: string;
  value?: unknown;
  replyToId?: string;
  entities?: Array<{ type: string; mentioned?: { id: string }; text?: string }>;
}

/** Where a Teams reply goes: the service URL the inbound token vouched for, and the conversation. */
export interface TeamsTarget {
  serviceUrl: string;
  conversationId: string;
  replyToId?: string;
}

/** The fixed, documented Bot Framework OpenID metadata; its `jwks_uri` serves the signing keys. Never read from a token. */
const OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const TOKEN_ISSUER = 'https://api.botframework.com';
const TOKEN_SCOPE = 'https://api.botframework.com/.default';
const CLOCK_TOLERANCE_SEC = 300;
const MAX_LENGTH = 25_000;
const MAX_ARGS = 2000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const NOT_ALLOWED = 'You are not allowed to approve this request.';

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** The Connector base URL of `serviceUrl`; only `https:` is accepted. */
function connectorBase(serviceUrl: string): string {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    throw new SDKError('teamsChannel: the service URL is not a URL', 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }
  if (url.protocol !== 'https:') throw new SDKError('teamsChannel: the service URL must use https', 'LOUSHO_CHANNEL_REQUEST_FAILED');
  return trimSlash(url.href);
}

/** A Teams user id (`29:1abc...`) has a colon, which the approval reference reserves: it travels percent-encoded. */
const encodeRef = (starter: unknown, id: string): string => encodeApprovalRef(typeof starter === 'string' ? encodeURIComponent(starter) : undefined, id);

function decodeRef(value: string): ApprovalRef {
  const ref = decodeApprovalRef(value);
  try {
    return { ...ref, starter: ref.starter === undefined ? undefined : decodeURIComponent(ref.starter) };
  } catch {
    return { id: ref.id }; // not what the channel wrote: no starter, so only a list of approvers can match
  }
}

interface Decision {
  lousho: 'approve' | 'deny';
  ref: string;
  conv?: string;
}

/** The `value` of an Adaptive Card `Action.Submit` that this channel posted, or `undefined`. */
function readDecision(value: unknown): Decision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { lousho, ref, conv } = value as Record<string, unknown>;
  return (lousho === 'approve' || lousho === 'deny') && typeof ref === 'string' && ref !== '' ? { lousho, ref, conv: typeof conv === 'string' ? conv : undefined } : undefined;
}

const card = (body: unknown[], actions?: unknown[]) => ({
  contentType: ADAPTIVE_CARD,
  content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body, ...(actions ? { actions } : {}) },
});

const submit = (title: string, data: Decision) => ({ type: 'Action.Submit', title, data });

/**
 * A Microsoft Teams bot channel (an Azure Bot with the Teams channel enabled).
 * Set the bot's messaging endpoint to `https://<host>/channels/teams`. Every
 * request must carry a Bot Framework JWT in `Authorization: Bearer`: its
 * signature is checked (RS256) against the key set named by the fixed Bot
 * Framework OpenID metadata, its issuer must be `https://api.botframework.com`,
 * its audience `appId`, and its `serviceurl` claim must equal the activity's
 * `serviceUrl` (401 otherwise); only then is the body parsed. The activity is
 * acknowledged with `200` at once and the turn runs after. A personal chat
 * always reaches the agent; in a group chat or channel only a message that
 * `@mentions` the bot does (the mention is removed from the text). One session per
 * conversation. Replies are Markdown posted to the `serviceUrl` the token
 * vouched for, split at 25,000 characters. A tool approval is an Adaptive Card
 * with Approve / Deny buttons that only `approvers` (default: the user who
 * started the turn) can use; the click names its conversation, so it works after
 * a restart and cannot be replayed into another conversation. An `ask_question`
 * is posted as text and the next message in the conversation is the answer.
 *
 * @example
 * ```ts
 * import { teamsChannel } from '@lousho/build-ai-agent';
 *
 * const teams = teamsChannel({
 *   appId: process.env.MICROSOFT_APP_ID ?? '',
 *   appPassword: process.env.MICROSOFT_APP_PASSWORD ?? '',
 * });
 * ```
 */
export function teamsChannel(options: TeamsChannelOptions): Channel<TeamsActivity> {
  if (!options.appId || !options.appPassword) {
    throw new ConfigurationError('teamsChannel: appId and appPassword must be non-empty strings.', options.appId ? 'appPassword' : 'appId');
  }
  if (options.tenantId !== undefined && !/^[A-Za-z0-9.-]+$/.test(options.tenantId)) {
    throw new ConfigurationError('teamsChannel: tenantId must be a tenant id or domain (letters, digits, "." and "-").', 'tenantId');
  }
  const { appId, appPassword } = options;
  const name = options.name ?? 'teams';
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const tokenUrl = `https://login.microsoftonline.com/${options.tenantId ?? 'botframework.com'}/oauth2/v2.0/token`;
  const questions = new Map<string, string>();
  // the service URL each verified body was vouched for (verify -> parse), keyed by the exact bytes
  const verified = new WeakMap<Uint8Array, string>();
  // The token's `endorsements` (which channels a key may sign for) are not checked: the issuer and the
  // audience already bind a token to this bot.
  const inboundAuth = oidc({
    issuer: TOKEN_ISSUER,
    audience: appId,
    discoveryUrl: OPENID_METADATA,
    algorithms: ['RS256'],
    clockToleranceSec: CLOCK_TOLERANCE_SEC,
    principal: (claims) => ({ id: 'bot-framework', type: 'service', authenticator: 'bot-framework', claims: Object.freeze({ ...claims }) }),
    fetch: doFetch,
  });

  let accessToken: { value: string; refreshAt: number } | undefined;
  let tokenRequest: Promise<string> | undefined;

  /** Asks the token endpoint for a client-credentials token. Errors name the status only: the response may echo the secret. */
  async function requestToken(): Promise<{ value: string; lifetimeMs: number }> {
    const failed = (why: string) => new SDKError(`teamsChannel: the token request failed: ${why}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appPassword, scope: TOKEN_SCOPE });
    const res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => {
      throw failed('the request did not complete');
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof body.access_token !== 'string' || body.access_token === '') throw failed(String(res.status));
    return { value: body.access_token, lifetimeMs: (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000 };
  }

  /** The outbound access token, cached until 5 minutes before it expires; one request at a time. */
  function token(): Promise<string> {
    if (accessToken && Date.now() < accessToken.refreshAt) return Promise.resolve(accessToken.value);
    tokenRequest ??= requestToken()
      .then(({ value, lifetimeMs }) => {
        accessToken = { value, refreshAt: Date.now() + Math.max(lifetimeMs - REFRESH_MARGIN_MS, 0) };
        return value;
      })
      .finally(() => (tokenRequest = undefined));
    return tokenRequest;
  }

  /** One Connector call. The access token goes in a header only; errors name the call and status. */
  async function connector(call: string, method: 'POST' | 'PUT', target: TeamsTarget, activityId: string | undefined, body: unknown): Promise<{ id?: string }> {
    const base = connectorBase(target.serviceUrl);
    const path = `${base}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities${activityId === undefined ? '' : `/${encodeURIComponent(activityId)}`}`;
    const bearer = await token();
    let res: Response;
    try {
      res = await doFetch(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch {
      throw new SDKError(`teamsChannel: ${call} failed: the request did not complete`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    }
    if (!res.ok) throw new SDKError(`teamsChannel: ${call} failed: ${res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    const sent = (await res.json().catch(() => ({}))) as { id?: unknown };
    return typeof sent.id === 'string' ? { id: sent.id } : {};
  }

  async function post(target: TeamsTarget, text: string): Promise<void> {
    for (const part of splitText(text, MAX_LENGTH)) {
      await connector('send activity', 'POST', target, target.replyToId, { type: 'message', text: part, textFormat: 'markdown', ...(target.replyToId ? { replyToId: target.replyToId } : {}) });
    }
  }

  /** A failure on a side effect of a click (the card update, the refusal notice) goes to `onError`; it must not stop the decision. */
  async function best(sessionId: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      await reportChannelError(options.onError, error, { channel: name, stage: 'reply', sessionId });
    }
  }

  const targetOf = (activity: TeamsActivity, replyToId: string | undefined = activity.id): TeamsTarget => ({
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    ...(replyToId ? { replyToId } : {}),
  });

  /** Whether the activity names the bot in an `@mention` entity (and the text those entities carry). */
  function botMentions(activity: TeamsActivity): string[] | undefined {
    const own = (activity.entities ?? []).filter((entity) => entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id);
    return own.length === 0 ? undefined : own.flatMap((entity) => (entity.text ? [entity.text] : []));
  }

  async function readClick(activity: TeamsActivity, click: Decision, ctx: ChannelContext): Promise<ChannelDecision | null> {
    // The card names the conversation it was posted in: a card reference copied into another conversation decides nothing.
    if (click.conv !== activity.conversation.id) return null;
    const key = activity.conversation.id;
    const ref = decodeRef(click.ref);
    const user: ChannelUser = { id: activity.from.id, name: activity.from.name };
    if (!(await mayApprove(options.approvers, user, ref, ctx, key))) {
      await best(ctx.sessionId(key), () => post(targetOf(activity), NOT_ALLOWED));
      return null;
    }
    const approved = click.lousho === 'approve';
    const cardId = activity.replyToId;
    if (cardId) {
      const outcome = `${approved ? 'Approved' : 'Denied'} by ${activity.from.name ?? activity.from.id}.`;
      await best(ctx.sessionId(key), () => connector('update card', 'PUT', targetOf(activity), cardId, { type: 'message', id: cardId, attachments: [card([{ type: 'TextBlock', text: outcome, wrap: true }])] }));
    }
    const inbound = { sessionKey: key, input: '', replyTo: targetOf(activity, cardId), ...(ref.starter ? { metadata: { user: ref.starter } } : {}) };
    return { decision: { id: ref.id, approved }, inbound, approver: user };
  }

  async function readMessage(activity: TeamsActivity, ctx: ChannelContext): Promise<ChannelInbound<TeamsActivity> | ChannelDecision | null> {
    const mentions = botMentions(activity);
    if (activity.conversation.conversationType !== 'personal' && !mentions) return null;
    let input = activity.text ?? '';
    for (const text of mentions ?? []) input = input.split(text).join(' ');
    input = input.trim();
    if (!input) return null;
    const key = activity.conversation.id;
    const { from, conversation } = activity;
    const inbound: ChannelInbound<TeamsActivity> = {
      sessionKey: key,
      input,
      replyTo: targetOf(activity),
      event: activity,
      metadata: { user: from.id },
      principal: { id: from.aadObjectId ?? from.id, type: 'user', authenticator: 'teams', ...(conversation.tenantId ? { issuer: conversation.tenantId } : {}) },
    };
    // the next message in the conversation answers a pending ask_question, also one asked before a restart
    return answerPendingQuestion(inbound, questions, ctx);
  }

  return defineChannel<TeamsActivity>({
    name,
    onError: options.onError,
    async verify(req: ChannelRequest) {
      const header = req.headers.authorization;
      if (typeof header !== 'string') return { ok: false, reason: 'missing bearer token' };
      let claims: Readonly<Record<string, unknown>> | undefined;
      try {
        claims = (await inboundAuth(new Request('https://teams.invalid/', { headers: { authorization: header } })))?.claims;
      } catch {
        return { ok: false, reason: 'bad authorization header' };
      }
      if (!claims) return { ok: false, reason: 'token rejected' };
      // the token is valid: now (and only now) read the body, and bind the token to the activity's service URL
      let serviceUrl: unknown;
      try {
        serviceUrl = (JSON.parse(req.text) as { serviceUrl?: unknown }).serviceUrl;
      } catch {
        return { ok: false, reason: 'body is not JSON' };
      }
      const claimed = claims.serviceurl ?? claims.serviceUrl; // Bot Framework tokens spell it in lower case
      if (typeof serviceUrl !== 'string' || typeof claimed !== 'string' || trimSlash(serviceUrl) !== trimSlash(claimed)) {
        return { ok: false, reason: 'serviceUrl does not match the token' };
      }
      verified.set(req.rawBody, serviceUrl);
      return { ok: true };
    },
    async parse(req: ChannelRequest, respond: ChannelRespond, ctx: ChannelContext) {
      respond(200, {}); // the Bot Framework gives a bot 15 seconds and retries
      const activity = JSON.parse(req.text || '{}') as TeamsActivity;
      if (verified.get(req.rawBody) !== activity.serviceUrl) return null; // only what verify vouched for
      if (activity.type !== 'message' || !activity.from?.id || !activity.recipient?.id || !activity.conversation?.id) return null;
      if (activity.from.id === activity.recipient.id) return null; // the bot's own messages
      // a card button arrives as a message with `value` and no text: handle it before the mention rule
      const click = readDecision(activity.value);
      if (click) return readClick(activity, click, ctx);
      return readMessage(activity, ctx);
    },
    reply: ({ inbound, text }) => post(inbound.replyTo as TeamsTarget, text),
    async onApproval({ inbound, approval, text }) {
      const target = inbound.replyTo as TeamsTarget;
      // N9b: a sign-in is its link as text, no Approve / Deny card (Teams has no message only one user sees).
      if (approval.kind === 'sign-in') return post(target, text);
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        return post(target, text);
      }
      const args = JSON.stringify(approval.args, null, 2);
      const data = { ref: encodeRef(inbound.metadata?.user, approval.id), conv: inbound.sessionKey };
      const body = card(
        [
          { type: 'TextBlock', text: `Approve \`${approval.toolName}\`?`, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: args.length > MAX_ARGS ? `${args.slice(0, MAX_ARGS)}\n... (truncated)` : args, fontType: 'Monospace', wrap: true },
        ],
        [submit('Approve', { lousho: 'approve', ...data }), submit('Deny', { lousho: 'deny', ...data })]
      );
      await connector('send approval card', 'POST', target, target.replyToId, { type: 'message', attachments: [body], ...(target.replyToId ? { replyToId: target.replyToId } : {}) });
    },
  });
}
