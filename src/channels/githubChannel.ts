/**
 * The GitHub channel (N11b): `@<botName>` in an issue, pull-request or review
 * comment starts a turn and the agent answers in the same thread. Webhooks
 * (`X-Hub-Signature-256`), replies as comments, and approvals as `/approve` and
 * `/deny` comments. Only `fetch` and Web Crypto: no `node:*` import and no
 * GitHub library.
 *
 * A comment is text written by anyone who can comment: it is untrusted input.
 */
import { ConfigurationError, SDKError } from '../execution/errors';
import { mayApprove, reportChannelError, type Approvers, splitText } from './channelSupport';
import { createInstallationTokens } from './githubAppAuth';
import {
  defineChannel,
  type Channel,
  type ChannelApprovalDecision,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelRespond,
  type ChannelUser,
} from './defineChannel';

/** Who wrote a comment, as the webhook reports it (`user.login`, `author_association`). */
export interface GitHubCommenter {
  /** The GitHub login. */
  login: string;
  /** `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN` or `NONE`. */
  association: string;
}

/**
 * Who may start a turn (or answer a question): a list of GitHub logins
 * (case-insensitive), or a function. Omitted: every human who can comment.
 */
export type GitHubTriggers = readonly string[] | ((commenter: GitHubCommenter) => boolean | Promise<boolean>);

/** Options of {@link githubChannel}. Give exactly one of `token` and `app`. */
export interface GitHubChannelOptions {
  /** The webhook secret of the GitHub App (or repository webhook); `X-Hub-Signature-256` is verified with it, in constant time. */
  webhookSecret: string;
  /** The invocation token without `@`, e.g. `my-agent` for `@my-agent`. */
  botName: string;
  /** A personal access token or an installation token for replies (or a function returning one). Never logged. */
  token?: string | (() => string | Promise<string>);
  /** GitHub App credentials: an installation token is fetched per event (`installation.id`) and cached. */
  app?: { appId: string; privateKey: string };
  /**
   * The login the replies are posted as, when it is not `<botName>[bot]` (a personal
   * access token posts as its user). Comments by it are never acted on. Default: `botName`.
   */
  botLogin?: string;
  /** Route segment. Default `github`. */
  name?: string;
  /** Default `https://api.github.com`; set it for GitHub Enterprise Server (`https://<host>/api/v3`). */
  apiUrl?: string;
  /** The `fetch` used for the REST API (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Who may start a turn: a list of logins or a function. Default: every human who
   * can comment, so on a public repository set this (or accept that anyone can
   * spend your model credits and write to your agent).
   */
  triggers?: GitHubTriggers;
  /**
   * Who may `/approve` and `/deny`: GitHub logins (case-insensitive), or a function
   * `(user, { toolName, input, sessionId })` where `user.id` is the login and
   * `user.roles` holds the `author_association`. Default: only a commenter whose
   * `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, read from the
   * command comment itself.
   */
  approvers?: Approvers;
  /** Failures after the webhook was acknowledged (reply delivery, the turn, an approval). Default: `console.error`. */
  onError?: ChannelErrorHandler;
}

/** A GitHub comment event, as `githubChannel()` reads it. */
export type GitHubCommentEvent = {
  kind: 'issue' | 'pull_request' | 'review_thread';
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  inReplyTo?: number;
  author: string;
  association: string;
  installationId?: number;
  body: string;
};

/** Where a GitHub reply goes. */
export interface GitHubTarget {
  owner: string;
  repo: string;
  number: number;
  /** Set for a review thread: the first comment of the thread, which replies are posted under. */
  reviewCommentId?: number;
  installationId?: number;
}

/** The webhook payload fields the channel reads. */
interface Payload {
  action?: string;
  installation?: { id?: number };
  repository?: { name?: string; owner?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: { number?: number };
  comment?: { id?: number; body?: string | null; in_reply_to_id?: number; author_association?: string; user?: { login?: string; type?: string } };
}

const MAX_COMMENT = 60_000; // GitHub's limit is 65,536
const NOT_ALLOWED = 'is not allowed to approve this request.';
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const COMMAND = /^\/(approve|deny)[ \t]+([A-Za-z0-9_-]{1,128})[ \t]*$/i;
const DEFAULT_APPROVER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** Hidden in every comment the channel posts, so it never acts on its own comments, whoever it posts as. */
const BOT_MARKER = '<!-- lousho:github-channel -->';
const MAX_ARGS = 20_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type CommentBase = Omit<GitHubCommentEvent, 'kind' | 'number' | 'inReplyTo'>;

/**
 * The fields every comment event has, or `null` for a webhook that is not a
 * newly created comment by a human other than the channel itself (a bot, its
 * own account, or a comment carrying the channel's marker).
 */
function readComment(payload: Payload, ownLogins: ReadonlySet<string>): CommentBase | null {
  const { comment, repository } = payload;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const login = comment?.user?.login;
  if (payload.action !== 'created' || !comment || typeof comment.id !== 'number' || !owner || !repo || !login) return null;
  const body = comment.body ?? '';
  if (comment.user?.type === 'Bot' || ownLogins.has(login.toLowerCase()) || body.includes(BOT_MARKER)) return null;
  const installationId = payload.installation?.id;
  return { owner, repo, commentId: comment.id, author: login, association: comment.author_association ?? 'NONE', body, ...(typeof installationId === 'number' ? { installationId } : {}) };
}

function readIssueEvent(base: CommentBase, payload: Payload): GitHubCommentEvent | null {
  const issue = payload.issue;
  return typeof issue?.number === 'number' ? { kind: issue.pull_request ? 'pull_request' : 'issue', number: issue.number, ...base } : null;
}

function readReviewEvent(base: CommentBase, payload: Payload): GitHubCommentEvent | null {
  const number = payload.pull_request?.number;
  const inReplyTo = payload.comment?.in_reply_to_id;
  return typeof number === 'number' ? { kind: 'review_thread', number, ...(typeof inReplyTo === 'number' ? { inReplyTo } : {}), ...base } : null;
}

/** A code fence longer than any backtick run in `text`, so the content cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${text}\n${fence}`;
}

/** Whether `header` (`sha256=<hex>`) is the HMAC-SHA256 of `rawBody` under `secret`; `crypto.subtle.verify` compares in constant time. */
async function signatureMatches(secret: string, header: string, rawBody: Uint8Array): Promise<boolean> {
  const hex = SIGNATURE.exec(header)?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const digest = new Uint8Array((hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16)));
  return crypto.subtle.verify('HMAC', key, digest, new Uint8Array(rawBody));
}

/**
 * A GitHub channel. Create a GitHub App (or a repository webhook) with the
 * webhook URL `<origin>/channels/github`, a secret (`webhookSecret`) and the
 * events **Issue comment** and **Pull request review comment**; the App needs
 * the permissions Issues and Pull requests: read and write. Every request's
 * `X-Hub-Signature-256` is verified over the raw body in constant time before
 * the body is parsed (401 otherwise); the webhook is acknowledged with `200` at
 * once and the turn runs after. A comment that contains `@<botName>` starts a
 * turn (the token is removed from the input); once a thread has a session,
 * every later comment in it is a follow-up. One session per issue or pull
 * request, and one per review thread. The agent answers with a new comment in
 * the same thread (split at 60,000 characters). A tool approval is a comment
 * that asks for `/approve <id>` or `/deny <id>`; by default only an `OWNER`,
 * `MEMBER` or `COLLABORATOR` may decide. Comments by bots, by the channel's own
 * account and edited or deleted comments are ignored.
 *
 * @example
 * ```ts
 * import { githubChannel } from '@lousho/build-ai-agent';
 *
 * const github = githubChannel({
 *   webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
 *   botName: 'my-agent',
 *   app: { appId: process.env.GITHUB_APP_ID ?? '', privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? '' },
 * });
 * ```
 */
export function githubChannel(options: GitHubChannelOptions): Channel<GitHubCommentEvent> {
  if (!options.webhookSecret || !options.botName) {
    throw new ConfigurationError('githubChannel: webhookSecret and botName must be non-empty strings.', options.webhookSecret ? 'botName' : 'webhookSecret');
  }
  if ((options.token === undefined) === (options.app === undefined)) {
    throw new ConfigurationError("githubChannel: give exactly one of 'token' and 'app'.", 'token');
  }
  if (options.app && (!options.app.appId || !options.app.privateKey)) {
    throw new ConfigurationError('githubChannel: app.appId and app.privateKey must be non-empty strings.', 'app');
  }
  const name = options.name ?? 'github';
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const botName = options.botName.replace(/^@/, '');
  const ownLogins = new Set([botName, `${botName}[bot]`, ...(options.botLogin ? [options.botLogin] : [])].map((login) => login.toLowerCase()));
  const mention = new RegExp(`(?<![A-Za-z0-9_-])@${escapeRegExp(botName)}(?![A-Za-z0-9_-])`, 'gi');
  const appTokens = options.app ? createInstallationTokens({ ...options.app, apiUrl, fetch: doFetch }) : undefined;
  const approverList = Array.isArray(options.approvers) ? (options.approvers as readonly string[]).map((login) => login.toLowerCase()) : options.approvers;
  const triggerList = Array.isArray(options.triggers) ? (options.triggers as readonly string[]).map((login) => login.toLowerCase()) : options.triggers;
  /** In-memory: the thread each approval prompt was posted in, and the pending `ask_question` of a thread. */
  const prompts = new Map<string, string>();
  const questions = new Map<string, string>();
  /** Approval ids this channel already passed on as a decision. */
  const decided = new Set<string>();

  async function tokenFor(installationId: number | undefined): Promise<string> {
    if (appTokens) {
      if (installationId === undefined) throw new SDKError('githubChannel: the event has no installation id, so no installation token can be requested', 'LOUSHO_CHANNEL_REQUEST_FAILED');
      return appTokens(installationId);
    }
    try {
      const token = typeof options.token === 'function' ? await options.token() : options.token;
      if (token) return token;
    } catch {
      // the message of a user function could carry a secret: it is not passed on
    }
    throw new SDKError('githubChannel: no token is available to post the reply', 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }

  /** POSTs a comment; errors name the call and the status only, never the token. */
  async function postTo(path: string, target: GitHubTarget, body: string): Promise<void> {
    const call = `POST ${path}`;
    const token = await tokenFor(target.installationId);
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'lousho',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
    } catch {
      throw new SDKError(`githubChannel: ${call} failed: the request did not complete`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    }
    if (!res.ok) throw new SDKError(`githubChannel: ${call} failed: ${res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
  }

  async function post(target: GitHubTarget, text: string): Promise<void> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    const path = target.reviewCommentId === undefined ? `${repo}/issues/${target.number}/comments` : `${repo}/pulls/${target.number}/comments/${target.reviewCommentId}/replies`;
    for (const part of splitText(text, MAX_COMMENT)) await postTo(path, target, `${part}\n\n${BOT_MARKER}`);
  }

  /** A failure posting a notice from `parse` goes to `onError`; it must not stop the decision. */
  async function best(target: GitHubTarget, text: string, sessionKey: string): Promise<void> {
    try {
      await post(target, text);
    } catch (error) {
      await reportChannelError(options.onError, error, { channel: name, stage: 'reply', sessionId: sessionKey });
    }
  }

  async function mayTrigger(commenter: GitHubCommenter): Promise<boolean> {
    if (triggerList === undefined) return true;
    if (typeof triggerList === 'function') return Boolean(await triggerList(commenter));
    return triggerList.includes(commenter.login.toLowerCase());
  }

  /** The default rule reads the association of the command comment itself, so it is as fresh as the delivery that carries it. */
  async function mayDecide(user: ChannelUser, association: string, id: string, ctx: ChannelContext, key: string): Promise<boolean> {
    if (approverList === undefined) return DEFAULT_APPROVER_ASSOCIATIONS.has(association);
    return mayApprove(approverList, typeof approverList === 'function' ? user : { ...user, id: user.id.toLowerCase() }, { id }, ctx, key);
  }

  /** Reads the webhook payload into a comment event, or `null` for anything the channel does not act on. */
  function readEvent(kind: string | undefined, payload: Payload): GitHubCommentEvent | null {
    const base = readComment(payload, ownLogins);
    if (!base) return null;
    if (kind === 'issue_comment') return readIssueEvent(base, payload);
    return kind === 'pull_request_review_comment' ? readReviewEvent(base, payload) : null;
  }

  const keyOf = (event: GitHubCommentEvent): string =>
    event.kind === 'review_thread' ? `${event.owner}/${event.repo}#${event.number}:${event.inReplyTo ?? event.commentId}` : `${event.owner}/${event.repo}#${event.number}`;

  const targetOf = (event: GitHubCommentEvent): GitHubTarget => ({
    owner: event.owner,
    repo: event.repo,
    number: event.number,
    ...(event.kind === 'review_thread' ? { reviewCommentId: event.inReplyTo ?? event.commentId } : {}),
    ...(event.installationId === undefined ? {} : { installationId: event.installationId }),
  });

  /** `/approve <id>` or `/deny <id>` on the first line only (a quote of the prompt in a reply decides nothing), then an optional note. */
  function readCommand(body: string): { approved: boolean; id: string; note?: string } | undefined {
    const [first = '', ...rest] = body.replace(/\r\n?/g, '\n').split('\n');
    const match = COMMAND.exec(first.trim());
    if (!match) return undefined;
    const note = rest.join('\n').trim();
    return { approved: match[1].toLowerCase() === 'approve', id: match[2], ...(note ? { note } : {}) };
  }

  async function readDecision(event: GitHubCommentEvent, command: { approved: boolean; id: string; note?: string }, ctx: ChannelContext): Promise<ChannelDecision | null> {
    const key = keyOf(event);
    const known = await ctx.approval(command.id); // only what this process paused on: after a restart the store alone knows
    if (known?.question || decided.has(command.id)) return null; // a question is answered by a comment; a repeated command (a redelivery) decides nothing twice
    const promptedIn = prompts.get(command.id);
    if (promptedIn !== undefined && promptedIn !== key) return null; // the prompt was posted in another thread
    const target = targetOf(event);
    const user: ChannelUser = { id: event.author, name: event.author, roles: [event.association] };
    if (!(await mayDecide(user, event.association, command.id, ctx, key))) {
      // refuse aloud only for an approval this process knows, so a made-up id gets no reply for anyone to provoke
      if (known) await best(target, `@${event.author} ${NOT_ALLOWED}`, key);
      return null;
    }
    decided.add(command.id);
    await best(target, `${command.approved ? 'Approved' : 'Denied'} by @${event.author}.`, key);
    const decision: ChannelApprovalDecision = { id: command.id, approved: command.approved, ...(command.note ? { note: command.note } : {}) };
    return { decision, inbound: { sessionKey: key, input: '', replyTo: target, metadata: { user: event.author, association: event.association } }, approver: user };
  }

  async function readMessage(event: GitHubCommentEvent, ctx: ChannelContext): Promise<ChannelInbound<GitHubCommentEvent> | ChannelDecision | null> {
    const command = readCommand(event.body);
    if (command) return readDecision(event, command, ctx);
    if (!(await mayTrigger({ login: event.author, association: event.association }))) return null;
    const key = keyOf(event);
    const mentioned = new RegExp(mention.source, 'i').test(event.body);
    const input = event.body.replace(mention, ' ').trim();
    if (!input) return null;
    const inbound: ChannelInbound<GitHubCommentEvent> = { sessionKey: key, input, replyTo: targetOf(event), event, metadata: { user: event.author, association: event.association }, principal: { id: event.author, type: 'user', authenticator: 'github' } };
    // the next comment in the thread answers a pending ask_question, also one asked before a restart
    const question = questions.get(key) ?? (await ctx.pendingQuestion(key));
    if (question) {
      questions.delete(key);
      return { decision: { id: question, answer: input }, inbound };
    }
    return mentioned || (await ctx.hasSession(key)) ? inbound : null;
  }

  return defineChannel<GitHubCommentEvent>({
    name,
    onError: options.onError,
    async verify(req: ChannelRequest) {
      const sent = req.headers['x-hub-signature-256'];
      if (typeof sent !== 'string') return { ok: false, reason: 'missing signature header' };
      return (await signatureMatches(options.webhookSecret, sent, req.rawBody)) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
    },
    async parse(req: ChannelRequest, respond: ChannelRespond, ctx: ChannelContext) {
      respond(200, { ok: true }); // GitHub gives a webhook 10 seconds and does not retry
      const kind = req.headers['x-github-event'];
      if (kind !== 'issue_comment' && kind !== 'pull_request_review_comment') return null; // ping and everything else
      const event = readEvent(kind, JSON.parse(req.text || '{}') as Payload);
      return event ? readMessage(event, ctx) : null;
    },
    reply: ({ inbound, text }) => post(inbound.replyTo as GitHubTarget, text),
    async onApproval({ inbound, approval }) {
      const target = inbound.replyTo as GitHubTarget;
      if (approval.question) {
        questions.set(inbound.sessionKey, approval.id);
        const options = (approval.question.options ?? []).map((option, i) => `\n${i + 1}. ${option}`).join('');
        return post(target, `${approval.question.text}${options}\n\nReply in this thread with your answer.`);
      }
      prompts.set(approval.id, inbound.sessionKey);
      const args = JSON.stringify(approval.args, null, 2);
      const shown = args.length > MAX_ARGS ? `${args.slice(0, MAX_ARGS)}\n... (truncated)` : args;
      return post(target, `The agent wants to run \`${approval.toolName}\` with:\n\n${fenced(shown)}\n\nReply \`/approve ${approval.id}\` or \`/deny ${approval.id}\`.`);
    },
  });
}
