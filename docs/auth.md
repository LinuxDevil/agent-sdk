# Route auth and principals

An agent served over HTTP needs to know two things about each request: may it
call at all, and who is it. `@lousho/build-ai-agent/auth` answers both. You
give a route an ordered list of auth entries (`jwt()`, `oidc()`, `basic()`,
`apiToken()`, `anonymous()` or your own function); the first entry that
accepts the request returns a **principal**, and that principal goes into the
run, where your `model` / `instructions` / `tools` functions and memory scopes
can read it.

```ts
import { createAgent, createRouteHandler } from '@lousho/build-ai-agent';
import { apiToken, jwt } from '@lousho/build-ai-agent/auth';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({
  provider: mockModel(['Hello!']),
  instructions: ({ principal }) => `You are helping ${principal?.id ?? 'a guest'}.`,
});

export const { GET, POST } = createRouteHandler(agent, {
  auth: [
    jwt({ secret: process.env.JWT_SECRET ?? 'a-development-secret-of-32-bytes!!', issuer: 'https://auth.example.com', audience: 'agent-api' }),
    apiToken(process.env.CI_TOKEN ?? 'ci-token', { id: 'ci' }),
  ],
});
```

## The auth list

Entries run in order, and each one does one of three things:

| An entry ... | Then |
| --- | --- |
| returns a `Principal` | the request is accepted; later entries are not asked |
| returns `null` or `undefined` | it skips: the next entry is asked |
| throws `AuthError(401)` or `AuthError(403)` | the request is refused with that status; later entries are not asked |

When every entry skips, the request gets a `401`. An empty list refuses every
request. An entry that throws anything else is a bug: the request gets a `500`
with a generic body, and the error is logged with `console.error` (never sent).

The built-in helpers never throw for a bad credential: a wrong password, an
expired token or a token for another audience all skip, so the next entry gets
its chance (two `jwt()` entries for two issuers work), and a request nobody
accepts ends in the same `401`.

A `Principal` is:

```ts no-verify
interface Principal {
  id: string;                                 // JWT `sub`, Basic user name, 'api-token', ...
  type: 'user' | 'service';
  authenticator: string;                      // 'jwt' | 'oidc' | 'basic' | 'api-token' | 'anonymous' | your name
  issuer?: string;                            // JWT `iss`: the same id from another issuer is another caller
  claims?: Readonly<Record<string, unknown>>; // verified claims; never the raw token or a password
}
```

## Helpers

All helpers are created once, at start-up, and check their options then: a
helper that cannot work throws [`LOUSHO_AUTH_CONFIG_INVALID`](./errors.md#lousho_auth_config_invalid)
instead of refusing every request later.

### `jwt()`

Accepts `Authorization: Bearer <JWT>` signed by the key you configure. Give
exactly one key source:

| Option | Key | Algorithms (default: all of the key's family) |
| --- | --- | --- |
| `secret` | an HMAC secret of at least 32 bytes | `HS256`, `HS384`, `HS512` |
| `publicKey` | a PEM `-----BEGIN PUBLIC KEY-----` or a JWK | `RS256`, `RS384`, `RS512` (RSA, 2048 bits or more), `ES256` (P-256), `ES384` (P-384) |
| `jwksUrl` | a JWKS endpoint (https, or http on localhost) | `RS256`, `ES256` by default; RSA and EC keys only |

```ts
import { jwt } from '@lousho/build-ai-agent/auth';

const fromOurAuthServer = jwt({
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com',
  audience: 'agent-api',
  // Map the verified claims to the principal; return null to skip.
  principal: (claims) => (typeof claims.sub === 'string' ? { id: claims.sub, type: 'user', authenticator: 'jwt', issuer: claims.iss, claims } : null),
});
```

What is checked:

- The header's `alg` must be one of `algorithms`; `none` is always refused, and
  so is a token whose header marks an extension `crit`.
- The algorithm must fit the key: a public key is never used as an HMAC secret,
  whatever the token's header says, and a key set never supplies an HMAC key.
- `exp` is required; `nbf` and `iat` are honored. All three allow
  `clockToleranceSec` of clock skew (default 60, at most 300).
- `iss` must equal one of `issuer` exactly (no trailing-slash tolerance), when
  you set `issuer`.
- `aud` (a string or a list) must contain one of `audience`. `audience` is
  required; pass `allowAnyAudience: true` to skip that check on purpose.
- A key set is fetched with a 5-second timeout, cached for 10 minutes, and
  refetched at most once every 30 seconds when a token names a `kid` it does
  not know (a failed fetch is retried on the same 30-second bound). Its URL is
  configuration only: the `jku`, `x5u` and `jwk` headers of a token are ignored.

The default principal is `{ id: sub, type: 'user', authenticator: 'jwt', issuer: iss, claims }`;
a token without `sub` skips.

### `oidc()`

A `jwt()` whose keys come from an OpenID Connect provider. It fetches
`<issuer>/.well-known/openid-configuration` once (or `discoveryUrl`), requires
the document's `issuer` to equal yours exactly, and uses its `jwks_uri` (https,
or http on `localhost` / `127.0.0.1` / `[::1]` — the same rule as `jwt()`'s
`jwksUrl`). Algorithms default to `RS256` and `ES256`; HMAC is not allowed.

```ts
import { oidc } from '@lousho/build-ai-agent/auth';

const google = oidc({ issuer: 'https://accounts.google.com', audience: process.env.GOOGLE_CLIENT_ID ?? 'client-id' });
```

The principal has `authenticator: 'oidc'` and the provider's `iss` as `issuer`.

### `basic()`

HTTP Basic credentials. User names and passwords are NFC-normalized and
compared in constant time, and every configured user is compared on every
request, so an unknown user takes as long as a wrong password. The `401`
carries `WWW-Authenticate: Basic realm="<realm>", charset="UTF-8"` so browsers
show their login prompt.

```ts
import { basic } from '@lousho/build-ai-agent/auth';

const operators = basic({ users: { ops: process.env.OPS_PASSWORD ?? 'change-me' }, realm: 'agent' });
// Or check against your own store (compare in constant time there):
const fromDatabase = basic({ users: async (user, password) => user === 'svc' && password === (process.env.SVC_PASSWORD ?? '') });
```

**Only use `basic()` over HTTPS**: the password travels with every request.

### `apiToken()` and `anonymous()`

`apiToken(token, { id })` accepts `Authorization: Bearer <token>` (compared in
constant time) as the service principal `{ id: id ?? 'api-token', type: 'service', authenticator: 'api-token' }`.
It is what a token string has always meant: `createRouteHandler({ auth: '<token>' })`
and `LOUSHO_API_TOKEN` are `apiToken()`. An empty string (`auth: ''`, e.g. an
env var that is set but blank) is refused with `LOUSHO_AUTH_CONFIG_INVALID`
by `createRouteHandler()` when it is created and by `serveFetch()` on every
request: it neither locks nor opens the routes silently.

`anonymous()` accepts everyone as `{ id: 'anonymous', type: 'user', authenticator: 'anonymous' }`:
put it last for routes that serve signed-in and anonymous callers, and read
`principal.authenticator` in the run.

### Your own entry

Any function of the `Request` is an entry. Declare the challenges it answers a
`401` with, or it advertises `Bearer`:

```ts
import { AuthError, type AuthFn } from '@lousho/build-ai-agent/auth';

const tenantKey: AuthFn = async (request) => {
  const key = request.headers.get('x-tenant-key');
  if (!key) return null; // not ours: ask the next entry
  if (key === 'suspended-tenant') throw new AuthError(403); // stop here
  return { id: key, type: 'service', authenticator: 'tenant-key' };
};
tenantKey.challenges = [{ scheme: 'Bearer', realm: 'tenants' }];
```

## 401, 403 and `WWW-Authenticate`

- Nobody accepted the request (or an entry threw `AuthError(401)`): `401` with
  `{ "error": "Unauthorized" }` and one `WWW-Authenticate` header per distinct
  challenge of the list, in order (`Bearer` for `jwt`, `oidc`, `apiToken`;
  `Basic realm="..."` for `basic`).
- An entry threw `AuthError(403)`: `403` with `{ "error": "Forbidden" }`.
- An entry failed in another way: `500` with `{ "error": "Internal Server Error" }`.

The body never says which check failed: an expired token, a bad signature and
a wrong audience all get the same `401`. Every auth response carries
`Cache-Control: no-store`. Tokens and passwords are never logged.

## Where it runs

| Helper or server | Node 22+ | Cloudflare Workers, Vercel Edge, Bun, Deno |
| --- | --- | --- |
| `jwt()`, `oidc()`, `basic()`, `apiToken()`, `anonymous()`, `routeAuth()` | yes | yes: Web Crypto and `fetch` only, no `node:` import |
| `createRouteHandler({ auth })` | yes | yes |
| `createDeployedServer({ auth })`, the `node-server` and `docker` targets | yes | no (Node `http`) |
| An agent directory's `auth.ts` | yes (`node-server`, `docker`) | no |
| The `cloudflare-worker` build target | | `LOUSHO_API_TOKEN` only; no auth list yet |

`oidc()` and `jwt({ jwksUrl })` need outbound `fetch` to the key set, which
every listed runtime has. In a hand-written Worker, call `createRouteHandler`
or `routeAuth()` yourself with any helper.

## `createRouteHandler`

`auth` takes the list, one entry, a token string, or (as before) a function
that returns a boolean. `true` accepts with the principal
`{ id: 'anonymous', type: 'user', authenticator: 'custom' }`, `false` is a
`401`. Without `auth` the route is open, and in production
(`NODE_ENV=production`) it logs one warning. `GET <basePath>/health` is never
behind `auth`. The accepted principal reaches every route: `POST <basePath>`,
`/chat`, approvals and the `useChat` endpoint. See [Next.js](./nextjs.md#routes).

## The node server and `auth.ts`

`createDeployedServer(agent, { auth })` takes the same list (or one entry).
When `LOUSHO_API_TOKEN` is set, `apiToken(LOUSHO_API_TOKEN)` is appended after
your entries, so an operator's token keeps working. Channels under
`/channels/<name>` are not behind the list: they verify their own requests.

In an [agent directory](./agent-directories.md), put the list in `auth.ts` (or
`auth.js`), next to `agent.ts`:

```ts no-verify
// my-agent/auth.ts
import { apiToken, oidc } from '@lousho/build-ai-agent/auth';

export default [
  oidc({ issuer: 'https://login.example.com', audience: 'agent-api' }),
  apiToken(process.env.CI_TOKEN!, { id: 'ci' }),
];
```

`lousho build --target=node-server` (or `docker`) bundles it, and the built
server uses it (`resolveAgentDir()` returns it as `auth`; the manifest says
`auth: true`). With an `auth.ts`, a token baked in with
`adapter.scaffold(..., { auth: { token } })` is not used; `LOUSHO_API_TOKEN`
still is. The `cloudflare-worker` target serves spec files only and keeps the
`LOUSHO_API_TOKEN` token; see [Deployment](./deployment.md#auth).

## Reading the principal in the run

The principal is on the run context next to `sessionId` and `metadata`. The
`vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent, defineMemory, inMemoryMemory, type Principal } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const notes = defineMemory({
  name: 'notes',
  // One memory per caller. Key on the issuer too: ids from different issuers can collide.
  scope: ({ principal }) => principal && `user:${principal.issuer ?? ''}:${principal.id}`,
  provider: inMemoryMemory(),
});

const agent = createAgent({
  provider: mockModel(['Hi!']),
  model: ({ principal }) => (principal?.claims?.plan === 'pro' ? 'openai/gpt-4o' : 'openai/gpt-4o-mini'),
  instructions: ({ principal }) => (principal?.type === 'service' ? 'Answer in JSON.' : 'Be friendly.'),
  memory: [notes],
});

// Outside a route, pass the principal yourself:
const caller: Principal = { id: 'u-42', type: 'user', authenticator: 'jwt', issuer: 'https://auth.example.com' };
await agent.send('Hello', { principal: caller });
await agent.session({ id: 'chat-1' }).send('Hello again', { principal: caller });
```

`principal` is separate from `metadata` on purpose: `metadata` is whatever the
caller sent, `principal` is what auth verified. A run that is resumed from its
checkpoint or after an approval keeps the principal it started with. The Slack,
Discord, Teams, GitHub and Telegram channels set the sender as the principal
(`authenticator: 'slack'`, `'discord'`, ...). Tools, approval policies,
permission rules and sub-agents see it too: see
[Principals in tools and approvals](#principals-in-tools-and-approvals).

## Security notes

- **Route auth does not check who owns a session** unless you pass
  `authorizeSession`. Without it, any caller who passes auth and knows a session
  id can read its transcript (`GET /chat/:id`) and continue it. Pass
  `authorizeSession`, use session ids that cannot be guessed, or derive them
  from the principal on your side. See
  [Who may use a session](#who-may-use-a-session).
- **Approvals.** A decision only reaches an approval of the session in the URL
  (another session's approval is a `404`). By default only the caller the run
  acts for may decide it. If an approval must come from someone else, such as a
  supervisor approving a customer's refund, set `authorizeApproval`. Otherwise
  the customer can approve their own call: the approval id is in their own
  stream. See [Who may decide an approval](#who-may-decide-an-approval).
- **Errors.** The session routes send an error's `name` and `code` with a
  generic message. The full error (a provider's response body, a chat template)
  goes to the server log (`console.error`) and to `onEvent`. Pass
  `exposeErrors: true` to send the raw message, as `lousho dev` does.
- `basic()` only over HTTPS; a bearer token is a password too, so terminate TLS
  in front of any server that is not on localhost.
- Keep `issuer` and `audience` set for `jwt()`: a token minted for another of
  your services is otherwise accepted here.

## Principals in tools and approvals

Everything that decides or acts on the caller's behalf gets the run's
principal, frozen (a tool or a policy that assigns to it throws):

| Where | How |
| --- | --- |
| A tool's `execute(args, ctx)` | `ctx.principal` |
| A `needsApproval` function | `ctx.principal` (its second argument) |
| A permission rule's `when(args, ctx)` | `ctx.principal` |
| `preToolCall` / `postToolCall` hooks | `ctx.principal` |
| `onPermissionDecision(entry, { principal })` | the second argument; the entry itself carries none |
| A pending approval (`agent.approvals.list()`, `approve`, a channel's `approvers` function) | `request.principal`: whose call it is |
| In-process sub-agents (`task`, background tasks) | the lead's principal, everywhere above |

A run without a principal (no route auth, `send()` without `principal`) has
none in any of these places.

### In a tool

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

export const myOrders = defineTool({
  name: 'my_orders',
  description: "Lists the caller's orders",
  input: z.object({}),
  execute: async (_args, ctx) => {
    if (!ctx.principal) return { error: 'Sign in first.' };
    // Key on the issuer too: the same id from another issuer is another caller.
    return { owner: `${ctx.principal.issuer ?? ''}:${ctx.principal.id}`, orders: [] };
  },
});
```

The principal comes only from route auth or a channel's verified sender, never
from the request body or the model, and a tool cannot change it.

### Approval policies and permission rules

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const deploy = defineTool({
  name: 'deploy',
  description: 'Deploys a service',
  input: z.object({ service: z.string() }),
  // Ask a human only when the caller has no `admin` claim.
  needsApproval: (_args, ctx) => ctx.principal?.claims?.admin !== true,
  execute: async ({ service }) => `deployed ${service}`,
});

const agent = createAgent({
  provider: mockModel(['Ready.']),
  tools: [deploy],
  // Service accounts (CI tokens) may not deploy at all.
  permissions: [{ tool: 'deploy', when: (_args, ctx) => ctx.principal?.type === 'service', action: 'deny', reason: 'Not for service accounts' }],
});

await agent.send('Deploy the API', { principal: { id: 'ci', type: 'service', authenticator: 'api-token' } });
```

### Who approved

A decision can name who made it. The approved tool sees the decider as
`ctx.approval.by`, next to `ctx.approval.note`:

```ts
import { createAgent, defineTool, type Principal } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Sends an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }, ctx) => `sent to ${to} for ${ctx.principal?.id}, approved by ${ctx.approval?.by?.id}`,
});

const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] }, 'Sent.']),
  tools: [sendEmail],
});
const alice: Principal = { id: 'alice', type: 'user', authenticator: 'jwt' };
const lead: Principal = { id: 'lead', type: 'user', authenticator: 'jwt' };

const paused = await agent.send('Email Sam', { principal: alice });
// The tool runs for alice; lead is recorded as the approver.
await agent.approvals.resolve({ id: paused.approvalId!, approved: true }, { principal: lead });
```

`resolve()`, `answer()`, `streamResolve()` and `streamAnswer()` take
`{ principal }`. The approvals route (`POST /chat/:sessionId/approvals/:id`)
passes the caller its auth list accepted; body fields cannot set it.
`mountChannels()` passes the user who clicked as
`{ id, type: 'user', authenticator: <channel name> }`, or, for a question
answered with a message, that message's sender. Decisions made by an `approve`
callback, or posted to `/channels/<name>/approvals/:id`, have no approver.

The approver never becomes the run's principal: the approved call and the
rest of the run act for the caller that paused it. A credential or a grant that
belongs to that caller is used only for that caller's calls, whoever approves.

### Who may use a session

`createRouteHandler()` and `createDeployedServer()` take `authorizeSession`.
It is asked before a caller reads a session (`action: 'read'`), sends it a
turn (`'chat'`, also `POST <basePath>` and the `useChat` endpoint) or decides
one of its approvals (`'approve'`). Return `false` for a `403`
(`LOUSHO_SESSION_FORBIDDEN`). Without it every caller route auth accepted may
use every session.

### Who may decide an approval

A decision posted to `POST /chat/:sessionId/approvals/:id` must name the
session the approval belongs to; any other session answers `404`, as for an
approval that was already decided. `POST <basePath>/approvals/:id` (the route
`useLoushoAgent` posts to) names no session, so it is checked against the
approval's own session.

Then `authorizeApproval({ principal, sessionId, approval })` decides; `false`
is a `403` (`LOUSHO_APPROVAL_FORBIDDEN`). The default, `callerOwnsApproval`,
lets only the caller the paused run acts for decide (`approval.principal`,
compared by `id`, `type`, `authenticator` and `issuer`). A user can confirm
their own call, and cannot decide another user's. A run without a principal,
or a route without auth, accepts any caller.

When `needsApproval` means that someone else must approve, say who. Here a
customer can no longer approve their own refund, and a supervisor can decide in
any session:

```ts
import { createAgent, createRouteHandler, memoryStore } from '@lousho/build-ai-agent';
import { jwt } from '@lousho/build-ai-agent/auth';

const agent = createAgent({ model: 'openai/gpt-4o-mini', store: memoryStore() });
const isSupervisor = (principal?: { claims?: Readonly<Record<string, unknown>> }) => principal?.claims?.role === 'supervisor';

export const { GET, POST } = createRouteHandler(agent, {
  auth: jwt({ secret: process.env.JWT_SECRET!, issuer: 'https://auth.example.com', audience: 'agent-api' }),
  // Customers use their own sessions (ids that start with their id); supervisors may decide in any session.
  authorizeSession: ({ principal, sessionId, action }) =>
    sessionId.startsWith(`${principal?.id}-`) || (action === 'approve' && isSupervisor(principal)),
  authorizeApproval: ({ principal }) => isSupervisor(principal),
});
```

Two requests that decide the same approval at once get one continuation: the
other request is a `409` (`LOUSHO_APPROVAL_CONFLICT`), and a later one a `404`.

### Pauses, crashes and forks

The principal is saved with the run's checkpoints and approval snapshots, so a
run resumed in another process (after a restart, `agent.approvals.resolve()`,
`agent.resume()`, a session's pending turn) acts for the same caller. A call
that continues an unfinished checkpointed run must pass no principal (it then
continues as the saved one) or the same one; another caller's
`send(message, { sessionId, principal })` throws `LOUSHO_CONFIG_INVALID`, so
its input never runs under someone else's identity. Checkpoints and snapshots
saved before this release have no principal and resume without one.

`agent.fork()` / `AgentExecutor.fork()` copy a run's checkpoint, principal
included: the fork is the same caller's run. A pending approval is not copied;
the fork asks again. `session.fork()` copies only the conversation: the fork
has no principal of its own, each of its turns runs with the principal its
`send()` passes, and a pending approval stays with the original session.

### Sub-agents

In-process sub-agents (the `task` tool and background tasks) act for the
lead's caller, also when their approval is
resumed. A [remote sub-agent](./sub-agents.md) (`remoteAgent()`) is not told who
the caller is: the remote server's own route auth decides its principal (for
example the `apiToken()` service principal of the lead's token).

### What is stored and logged

The principal, claims included, is stored in checkpoints and approval records,
which already hold the transcript; treat those stores as personal data. It is
not added to `AgentEvent`s (`permission.decision` included), OpenTelemetry
spans or trace files, and error messages do not name callers.
