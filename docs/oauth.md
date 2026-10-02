# OAuth

Tools and MCP servers that call an API on someone's behalf need an OAuth
access token, and usually a refresh token to get the next one. This page covers
where those tokens live: the `tokens` part of an `AgentStore`, keyed by
provider and by who owns the credential. Signing in (the redirect, the
callback route, pausing a run until the user connects) comes in a later
release; for now the store is the building block, and nothing signs in by
itself.

## Credential owners

Every stored credential has a provider (a name such as `github`, 1-64
characters from `A-Z`, `a-z`, `0-9`, `_` and `-`) and an owner:

- **The app** (`{ owner: 'app' }`): one credential the agent uses for
  everybody, such as a service account or a bot installation.
- **A user** (`{ owner: 'user', principalId, issuer? }`): one credential per
  signed-in person. `principalId` is the user's id and `issuer` names the
  identity provider that issued it, so `alice` from one issuer and `alice`
  from another are different owners. With route auth, a request's principal
  maps onto it as `{ owner: 'user', principalId: principal.id, issuer:
  principal.issuer }`; a user credential needs that principal, because
  without one there is no user to own it.

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
about a minute) could both read the same state. The state is a 128-bit random
value that only the user's browser holds, so reusing it gains nothing to anyone
who does not already have it. `KVStore`'s `tokens.list()` needs the binding's
`list()` (a real KV namespace has it; a hand-made fake may not). `prune()` of a
`SqliteStore` also deletes expired pending sign-ins; the file store drops them
when the next sign-in starts, and KV expires them itself.
