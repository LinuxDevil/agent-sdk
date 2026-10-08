# OAuth

Tools and MCP servers that call an API on someone's behalf need an OAuth
access token, and usually a refresh token to get the next one. This page covers
where those tokens live: the `tokens` part of an `AgentStore`, keyed by
provider and by who owns the credential, and how a tool gets one: a tool calls
`ctx.getToken(provider)`, and when the user has not connected yet the run
pauses until they sign in ([Tools that need sign-in](#tools-that-need-sign-in)).
HTTP MCP servers sign in with OAuth too
([MCP servers with OAuth](#mcp-servers-with-oauth)).

## Credential owners

Every stored credential has a provider (a name such as `github`, 1-64
characters from `A-Z`, `a-z`, `0-9`, `_` and `-`) and an owner:

- **The app** (`{ owner: 'app' }`): one credential the agent uses for
  everybody, such as a service account or a bot installation.
- **A user** (`{ owner: 'user', principalId, issuer? }`): one credential per
  signed-in person. `principalId` is the user's id and `issuer` names the
  identity provider that issued it, so `alice` from one issuer and `alice`
  from another are different owners. With [route auth](auth.md), a request's
  principal maps onto it as `{ owner: 'user', principalId: principal.id,
  issuer: principal.issuer }`; a user credential needs that principal,
  because without one there is no user to own it.

`tokenStoreKey(provider, owner)` is the record key of a credential:
`<provider>|app`, or `<provider>|user|<issuer>|<principalId>` with the issuer
and id percent-encoded (an absent issuer is the empty part). Encoding makes the
key unambiguous: a principal id containing `|` cannot collide with another
owner.

```ts
import { tokenStoreKey } from '@lousho/build-ai-agent';

tokenStoreKey('github', { owner: 'app' }); // 'github|app'
tokenStoreKey('github', { owner: 'user', principalId: 'a|b', issuer: 'https://id.example.com' });
// 'github|user|https%3A%2F%2Fid.example.com|a%7Cb'
```

## Token storage

`AgentStore.tokens` is an `OAuthTokenStore`:

```ts
import { memoryStore } from '@lousho/build-ai-agent';

const { tokens } = memoryStore();
const alice = { owner: 'user', principalId: 'alice', issuer: 'https://id.example.com' } as const;

await tokens.set('github', alice, { accessToken: 'gho_...', refreshToken: 'ghr_...', tokenType: 'Bearer', expiresAt: Date.now() + 3_600_000 });
const token = await tokens.get('github', alice); // { accessToken, refreshToken, ... } or undefined
const connected = await tokens.list({ owner: alice }); // [{ provider: 'github', owner, expiresAt, scope, hasRefreshToken: true, updatedAt }]
await tokens.delete('github', alice); // disconnect
```

- `get`, `set` and `delete` read, write (replacing) and remove one credential.
- `list({ provider?, owner? })` returns metadata only: provider, owner, token
  type, expiry, scope, whether a refresh token is stored, and when the record
  was written. It never returns an access or refresh token.
- `putPending(state, value, ttlMs)` and `takePending(state)` keep a sign-in in
  progress (the PKCE verifier and where to return) between the redirect and the
  callback. `takePending` returns it once and deletes it; after `ttlMs` it is
  gone. `state` is 16-128 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`; a
  malformed state passed to `takePending` is simply not found.
- `setClient(provider, client)` and `getClient(provider)` keep a client
  registered with an authorization server (dynamic client registration). The
  record may hold a client secret, so it is encrypted like a token.

Every ready-made store has `tokens`:

| Store | Where tokens are kept | Encrypted |
| --- | --- | --- |
| `memoryStore()` | Plain objects in process memory | No: nothing leaves the process |
| `fileStore(dir, { tokenKey })` | `<dir>/oauth/tokens/<sha256 of the key>.json`, `<dir>/oauth/pending/<state>.json` | Yes |
| `new SqliteStore(path, { tokenKey })` | Tables `oauth_tokens` and `oauth_pending` | Yes |
| `new KVStore(kv, { tokenKey })` | `<prefix>oauth/tokens/<key>`, `<prefix>oauth/pending/<state>` (with an expiration) | Yes |

**The key.** The persistent stores encrypt every record with AES-256-GCM under
a 32-byte key that you supply as base64: the `tokenKey` option, or else the
`LOUSHO_TOKEN_KEY` environment variable. There is no default key and nothing
is derived from a password. Make one with `generateTokenKey()` or in a shell:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

```ts
import { createAgent, fileStore, generateTokenKey } from '@lousho/build-ai-agent';

console.log(generateTokenKey()); // store it as a secret, e.g. LOUSHO_TOKEN_KEY

const agent = createAgent({ provider, store: fileStore('./.lousho', { tokenKey: process.env.LOUSHO_TOKEN_KEY }) });
```

On Cloudflare Workers there is no `process.env`: add the key as a secret
(`wrangler secret put LOUSHO_TOKEN_KEY`) and pass `env.LOUSHO_TOKEN_KEY` as
`tokenKey`. The Worker that `lousho build --target=cloudflare-worker`
generates does this for you.

- A key that is not exactly 32 bytes of base64 is a `ConfigurationError` when
  the store is built.
- With no key, an agent that never stores a token works as before: reads find
  nothing. The first `set`, `setClient` or `putPending` throws
  [`LOUSHO_TOKEN_KEY_MISSING`](errors.md#lousho_token_key_missing), and so does
  reading a record that exists.
- Each write uses a fresh random 12-byte IV, so the same token written twice
  gives two different ciphertexts. The record key is authenticated with it: a
  ciphertext copied to another owner's row does not decrypt. The stored form is
  `v1.<base64 iv>.<base64 ciphertext>`.
- A record written under another key, or changed on disk, fails with
  [`LOUSHO_TOKEN_DECRYPT_FAILED`](errors.md#lousho_token_decrypt_failed), which
  names the provider and never the token.

**Rotating the key.** Pass several keys, newest first:
`tokenKey: [newKey, oldKey]`, or `LOUSHO_TOKEN_KEY="<new>,<old>"`. Writes use
the first key and reads try each in turn, so tokens move to the new key as they
are refreshed. There is no command that re-encrypts every record; once you drop
the old key, tokens still written under it can no longer be read, and their
users sign in again (delete those records).

**Nothing logs a token.** The stores never put an access token, refresh token,
PKCE verifier or client secret into an error message, a log line or an error
`cause`, and the token values are not part of agent events, transcripts,
checkpoints, traces or recorded cassettes unless a tool returns one itself. A
tool that uses a token should return the API's answer, not the token.

**Consistency.** SQLite takes a pending sign-in in one transaction, and the
file store claims it with an exclusive file create, so exactly one caller gets
it. Workers KV has no transactions: `takePending` reads and then deletes, so two
callbacks at different edge locations within KV's propagation delay (up to
about a minute) could both read the same state. The state is a 256-bit random
value that only the user's browser holds, so reusing it gains nothing to anyone
who does not already have it. `KVStore`'s `tokens.list()` needs the binding's
`list()` (a real KV namespace has it; a hand-made fake may not). `prune()` of a
`SqliteStore` also deletes expired pending sign-ins; the file store drops them
when the next sign-in starts, and KV expires them itself.

## Tools that need sign-in

Define the provider once, at module level next to the tools that use it, with
`defineOAuthProvider()`. A tool asks for a token with `ctx.getToken(provider)`:

```ts
import { createAgent, defineOAuthProvider, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { z } from 'zod';

export const github = defineOAuthProvider({
  name: 'github', // also the token store key
  displayName: 'GitHub', // shown on the sign-in prompt
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: process.env.GITHUB_CLIENT_ID ?? 'client-id',
  clientSecret: process.env.GITHUB_CLIENT_SECRET, // omit for a public client
  scopes: ['repo'],
  redirectUri: 'https://agent.example.com/api/agent/oauth/callback', // as registered with GitHub
});

const listRepos = defineTool({
  name: 'list_repos',
  description: "Lists the user's repositories",
  input: z.object({}),
  execute: async (_args, ctx) => {
    const { accessToken } = await ctx.getToken(github); // first, before any side effect
    const res = await fetch('https://api.github.com/user/repos', { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) ctx.requireAuth(github); // the token was revoked: sign in again
    const repos = (await res.json()) as Array<{ full_name: string }>;
    return repos.map((repo) => repo.full_name); // the API's answer, never the token
  },
});

const agent = createAgent({ provider, tools: [listRepos], store: memoryStore() });
```

- `getToken()` reads the token of the run's [principal](auth.md)
  (`credentialOwner: 'user'`, the default) or the app's own
  (`credentialOwner: 'app'`) from `store.tokens`. A token that expires within
  60 seconds and has a refresh token is refreshed at `tokenUrl` first and
  saved; a refresh the server refuses deletes it.
- Without a usable token the run **pauses**, exactly like an
  [approval](approvals.md): `finishReason: 'awaiting-approval'`, a pending
  approval with `kind: 'sign-in'`, durable in the agent's stores. Once the user
  signed in and the pause is approved, the tool call runs again **from the
  start**. Call `getToken()` before anything with a side effect: work done
  before it is done twice.
- `ctx.requireAuth(provider)` is for a token the API refused (a 401): it
  deletes the stored token and pauses for a new sign-in.
- A user credential needs a principal: on a run without one (no route auth,
  no channel), `getToken()` fails the call with
  [`LOUSHO_OAUTH_PRINCIPAL_REQUIRED`](errors.md#lousho_oauth_principal_required)
  and nothing pauses.
- The agent needs a token store (`store` with `tokens`); without one the run
  stops with [`LOUSHO_OAUTH_STORE_MISSING`](errors.md#lousho_oauth_store_missing).
- The provider is registered under its `name` for the process, so the
  callback can finish a sign-in that started in another request or before a
  restart. Defining the same name again replaces it.

**App credentials.** A provider with `credentialOwner: 'app'` holds one token
for everyone (a bot installation, a service account). A chat user is never sent
its sign-in link, because whoever opened it would connect their own account as
the agent's credential for every user: without the token the call fails with
[`LOUSHO_OAUTH_APP_SIGNIN_REQUIRED`](errors.md#lousho_oauth_app_signin_required).
The operator signs the app in once with `agent.oauth.signInUrl(provider)`:

```ts
import { createAgent, defineOAuthProvider, fileStore } from '@lousho/build-ai-agent';

const slackBot = defineOAuthProvider({
  name: 'slack_bot',
  displayName: 'Slack',
  credentialOwner: 'app',
  authorizationUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  clientId: process.env.SLACK_CLIENT_ID ?? 'client-id',
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  scopes: ['chat:write'],
  redirectUri: 'https://agent.example.com/oauth/callback',
});

// connect-slack.ts: run once against the deployed agent's store, open the URL, approve.
const agent = createAgent({ provider, store: fileStore('./.lousho', { tokenKey: process.env.LOUSHO_TOKEN_KEY }) });
console.log('Open this to connect the app:', await agent.oauth.signInUrl(slackBot));
```

The link works for 10 minutes; the callback route of the deployed agent (which
shares the store) stores the token, and every run uses it from then on, with or
without a principal.

## What the user sees

The pause is reported like any approval, with the link to open:

- The `approval.requested` event (and the `run.done` with
  `finishReason: 'awaiting-approval'` after it) has `kind: 'sign-in'` and
  `signIn: { provider, displayName?, url }`. `agent.approvals.list()` returns
  the same record. Show `url`; once the user is back, approve the pause ("I've
  signed in") with `agent.approvals.resolve({ id, approved: true })` or
  `POST /chat/:id/approvals/:approvalId { "approved": true }`. Approving before
  the callback stored a token throws
  [`LOUSHO_SIGNIN_PENDING`](errors.md#lousho_signin_pending) (HTTP 409 on the
  route) and the run stays paused. `approved: false` cancels: the model gets a
  `kind: 'denied'` tool error "Sign-in to GitHub was cancelled.".
- An `approve` callback is never asked about a sign-in: only the user can sign in.
- React, Vue and Svelte apps get it as `pendingApproval.kind === 'sign-in'`
  with `pendingApproval.signIn`; render the link and call `approve()` when the
  user says they are done (`reject()` cancels). The `data-lousho-approval`
  part of the AI SDK stream carries `kind` and `signIn` too.
- [Channels](channels.md) post the default prompt "Sign in to GitHub to
  continue: <url>" without Approve / Deny buttons. Slack sends it with
  `chat.postEphemeral` to the user who started the turn and Discord as an
  ephemeral follow-up, so nobody else in the thread sees the link. Teams and
  Telegram have no message only one user sees, so they send the link only in a
  1:1 chat with the bot; in a group chat or channel they post "please sign in
  from a private chat with me" instead. GitHub never posts it in a public
  thread. Behind
  `createDeployedServer()` and `lousho dev`, the callback continues the paused
  channel turn by itself, and the answer is posted where the question was asked.
- `lousho dev`'s chat page shows the link with "I've signed in" and "Cancel";
  `lousho chat` and `lousho acp` show the link and ask again until the user is
  signed in.

## The callback route

`redirectUri` must point at `GET /oauth/callback` of the served agent, exactly
as registered with the provider:

| Host | Callback |
| --- | --- |
| `lousho dev`, the node server, the Docker image, the Worker | `GET /oauth/callback` |
| `createRouteHandler(agent, { basePath })` | `GET <basePath>/oauth/callback` (e.g. `/api/agent/oauth/callback`) |

The route is **not** behind route auth or the bearer token: a browser redirect
carries no API token. Its protection is the `state`: 32 random bytes, single
use, valid for 10 minutes. It calls `agent.oauth.complete({ state, code, error })`
and answers a small HTML page ("Signed in to GitHub. You can close this tab.",
or the cancelled text when the provider sent `error`), with
`cache-control: no-store`, no script, and no query value echoed. An unknown,
used or expired `state` answers 400; a refused code exchange 502
([`LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED`](errors.md#lousho_oauth_token_exchange_failed)).
When the callback request does pass the route's auth (a session cookie your
auth function accepts, for example), a sign-in started for another user is
refused.

`agent.oauth.complete()` only stores the token: the client that showed the
link continues the run by approving the pause. Serving your own route, do the
same:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ provider });

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const { outcome } = await agent.oauth.complete({
    state: query.get('state') ?? '',
    code: query.get('code') ?? undefined,
    error: query.get('error') ?? undefined,
  });
  return new Response(outcome === 'signed-in' ? 'Signed in. You can close this tab.' : 'Sign-in cancelled.');
}
```

When the user declines at the provider, `complete()` returns
`outcome: 'declined'`, and approving the pause then cancels the call like
`approved: false`.

## Approval and sign-in together

A tool with `needsApproval` asks first: the approval gate runs before the
tool's `execute`. Once approved, the call starts, `getToken()` finds no token
and the run pauses again, this time for sign-in. After the sign-in, approving
that pause runs the call once; it is not put to the reviewer a second time.
A call that needs sign-in to two providers pauses once for each, in turn.

When several calls of one model turn need sign-in, the run pauses on the first
one; the others run after it is decided, like the rest of a turn paused on an
approval.

## Security

- **PKCE and state.** Every sign-in uses PKCE with S256 (a 32-byte verifier)
  and a 32-byte random `state`. The verifier is kept only in the encrypted
  pending record (`store.tokens.putPending`), never in the approval snapshot,
  a checkpoint or an event; the `state` is single use and expires after 10
  minutes. The authorization URL holds the `state` and the challenge, which
  are safe to show; the authorization code is never logged.
- **Encryption.** Tokens and pending sign-ins are encrypted at rest by the
  persistent stores ([Token storage](#token-storage)).
- **Principal binding.** A user's token is stored for the principal the paused
  run acts for, whoever completes the callback, and a run only ever reads its
  own principal's token. Two users' tokens never mix; the same id from another
  issuer is another user. An app credential is only signed in by the operator.
- **Who sees the link.** Whoever opens a sign-in link binds their own account
  to the user who asked. Show it only to that user: the run's own stream, an
  ephemeral message in a shared channel (Slack, Discord), a 1:1 chat
  (Telegram, Teams), never a group chat or a public thread.
- **Never return a token from a tool.** Return the API's answer. As a safety
  net, a tool result that contains a token `getToken()` handed out during that
  call has it replaced with `[REDACTED]` before it is recorded, and a warning
  names the tool. Tokens never enter agent events, transcripts, checkpoints,
  approval records, trace spans or recorded cassettes.

## MCP servers with OAuth

Hosted MCP servers such as Linear, GitHub, Atlassian and Notion require OAuth
2.1 as defined by the MCP authorization specification. Give an HTTP entry of
`mcpServers` an `oauth` field and the SDK does the protocol: it reads the
server's protected resource metadata (RFC 9728) to find its authorization
server, reads that server's metadata (RFC 8414), registers a client when you
have none (dynamic client registration, RFC 7591), and signs in with PKCE
(S256) and a resource indicator (RFC 8707). Tokens are kept in the agent's
token store (encrypted by the persistent stores) under the provider name
`mcp-<server>` and refreshed by the MCP SDK when the server refuses an expired
one.

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const agent = createAgent({
  provider,
  mcpServers: {
    linear: {
      url: 'https://mcp.linear.app/mcp',
      oauth: { redirectUri: 'https://agent.example.com/oauth/callback' },
    },
  },
  store: new SqliteStore('./agent.db', { tokenKey: process.env.LOUSHO_TOKEN_KEY }),
});

// connect-linear.ts: run once against the deployed agent's store, open the URL, approve.
console.log('Open this to connect Linear:', await agent.oauth.mcpSignInUrl('linear'));
```

`oauth` takes:

- `redirectUri` (required): the agent's callback URL, the
  [callback route](#the-callback-route) of the deployed agent.
- `clientId`, and `clientSecret` for a confidential client: a client you
  registered with the authorization server yourself. Without `clientId`, the
  SDK registers one at the first sign-in (as `clientName`, default `lousho`,
  with `redirectUri` as its only redirect URI) and keeps it in the token store.
- `scopes`: requested when the server's metadata names none.

**Signing in.** The grant belongs to the app, like an
[app credential](#tools-that-need-sign-in): one sign-in for the whole agent,
by an operator: `agent.oauth.mcpSignInUrl('<server>')` (the last line of the
example above) returns the authorization URL; the operator opens it and
approves, and the callback route of the deployed agent, which shares the
store, stores the token. The link works once, for 10 minutes. `mcpSignInUrl()` always makes a new link,
even when a token is stored, so it also re-connects the app to another account.
The next `ready()` or tool call connects with the new token; nothing needs a
restart.

**`needs-auth`.** Until the app is signed in, or after the grant was revoked
(the token is refused and the refresh token too), the server's status is
`'needs-auth'` and connecting fails with
[`LOUSHO_MCP_AUTH_REQUIRED`](errors.md#lousho_mcp_auth_required): `ready()`
and the first `send()` reject with it (or, with `connectMcp(servers, { onError:
'skip' })`, the server is left out). A tool call refused during a run is an
error result for the model, with the same code; the run does not pause, because
a chat user never signs in for the app. A connection never registers a client
or starts a sign-in by itself: only `mcpSignInUrl()` does.

**Security.**

- `oauth` needs an `https` url; plain `http` is allowed only for `localhost`,
  `127.0.0.1` and `[::1]`. `headers` still work next to `oauth` (an API key
  header, say) and are sent only to the MCP server's own origin, never to the
  authorization server; an `Authorization` header together with `oauth` is
  refused.
- A token is sent only to the `url` it was obtained for. When the entry's
  `url` changes, the stored grant and any registered client are not used, and
  the server needs a new sign-in. The SDK also refuses protected resource
  metadata whose `resource` does not match the server's url.
- Tokens, authorization codes, PKCE verifiers and the client secret never
  appear in error messages, log lines, `status()`, agent events or tool
  results; an authorization server's error is reported by its OAuth `error`
  code only.

**Limits.** MCP grants are app-owned: one connection and one token per server
for every user of the agent. Per-user MCP grants (each user signing in with
their own account, with their own tool list) are not supported yet. OAuth
applies to HTTP servers only, not stdio. Client ID metadata documents and
`private_key_jwt` client authentication are not supported.

For `connectMcp()` without an agent, pass the store as
`connectMcp(servers, { tokens: store.tokens })`; it uses the stored token, and
signing in goes through an agent's `agent.oauth.mcpSignInUrl()` on the same
store.
