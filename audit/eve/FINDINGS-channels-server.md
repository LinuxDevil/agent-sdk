# Eve findings — channels & server surfaces

Audit of `src/channels/*`, `src/server/*`, `src/deploy/nodeServer*` against
`docs/channels.md`, `docs/nextjs.md`, `docs/auth.md`, `docs/deployment.md`.
All repros run with `npx tsx` against the repo source; scripts are in
`audit/eve/channels/r*.ts`. Prior fixes (webhook `approvalPrompt`,
`pullRequestOpened`, disconnect-commits-turn, `authorizeSession`/
`authorizeApproval`) were verified working and are not re-reported.

## Summary

The channel pipeline is well-architected (raw-body signatures, per-session
serialization, restart-safe approval binding via checkpoints) and the
signature verification for Slack/GitHub/Teams/Discord is solid. The
evaluator-visible problems are: (1) the deployed node server mounts channels
without the agent's store, so the documented "survives a restart" guarantees
fail on `node-server`/`docker`; (2) `webhookChannel` is silently broken on
every Fetch host — authenticated requests always get 401; (3)
`docs/nextjs.md` documents a session-binding feature (`ownsSession`) that
does not exist; (4) channel error paths leak raw internal error messages
where the session routes deliberately redact them; and (5) no channel has
any delivery idempotency (Telegram `update_id`, GitHub `X-GitHub-Delivery`),
so redeliveries re-run turns with real side effects.

---

## High

### F1: `createDeployedServer` mounts channels with a private in-memory store — channel sessions never survive a restart

- **Persona:** AI engineer / PM. Docs (`docs/channels.md` "Sessions",
  `#slack`, `#github`) promise `hasSession`/`pendingQuestion` restart
  survival "given durable stores"; `docs/deployment.md` says
  `LOUSHO_STORE=sqlite` makes "sessions survive restarts".
- **Evidence:** `src/deploy/nodeServer.ts:95` calls
  `mountChannels(agent, options.channels)` with **no `store`**, so
  `channelCore` falls back to `new MemorySessionStore()`
  (`src/channels/channelCore.ts:101`). `DeployedServerOptions` has no way to
  pass one, and `SimpleAgent` does not expose its store, so there is no
  user-side workaround. Contrast `lousho dev` (`src/cli/devReload.ts:185`
  passes `{ store: state.store }`) and the Worker target
  (`src/deploy/runtime.worker.ts:296` passes `{ store: workerStore(env) }`) —
  only the node/docker targets drop it.
- **Repro:** `audit/eve/channels/r5-deployed-store.ts` — an agent with
  `memoryStore()` served by `createDeployedServer`; after a channel turn the
  transcript is **not** in the agent's store (`store.sessions.load(id)` →
  `undefined`). Consequence beyond lost transcripts: `ctx.hasSession` reads
  that private store (`channelCore.ts:119`), so after a restart a Slack
  thread follow-up **without** a mention is silently ignored
  (`slackChannel.ts:210`), even though the docs say it continues the session.
  Checkpointed pauses do still bind (checkpoints fall back to the agent's
  store via `withDefaultStores`), so restart behavior is incoherent:
  `/approve` and ask-question answers survive, follow-ups and transcripts
  don't.
- **Suggested fix:** pass the agent's store into `mountChannels` in
  `createDeployedServer` (expose it on `SimpleAgent`, or have
  `createDeployedAgent` return/accept the `AgentStore` and thread it through
  the emitted server template in `src/deploy/adapters/node-server.ts`).

### F2: `webhookChannel` is broken on every Fetch host — authenticated requests always 401

- **Persona:** software engineer (raw-body / header handling) + PM (can't
  ship the generic webhook on Workers/Next).
- **Evidence:** `webhookChannel.verify` hands `req.native` to
  `checkWebhookAuth` (`src/channels/webhookChannel.ts:50`), which reads
  headers node-style: `req.headers[name.toLowerCase()]`
  (`src/triggers/webhookAuth.ts:106-109`). Under `mountFetchChannels`,
  `req.native` is a Fetch `Request`, so `req.headers['x-signature-256']` is
  `undefined` on a `Headers` object — every signed request returns
  `'missing or malformed signature'` → 401. Same for `bearer` and `custom`
  auth (`verify` receives a `Request` mistyped as `IncomingMessage`). The
  file is also marked "Node-only: HMAC checks use `node:crypto`" and uses
  `Buffer`, yet `docs/channels.md` never flags it as Node-only while
  claiming `mountFetchChannels()` "serves the same routes" and the
  Worker runtime mounts agent-directory `channels/` unconditionally
  (`runtime.worker.ts:296`).
- **Repro:** `audit/eve/channels/r2-webhook-fetch.ts` — a correctly
  HMAC-signed request through `mountFetchChannels` → `401`.
- **Suggested fix:** either make `webhookChannel` fetch-safe (read
  `req.headers` from `ChannelRequest` directly — they are already
  normalized — and use Web Crypto / `Uint8Array` instead of
  `node:crypto`/`Buffer`), or throw a clear "not supported on fetch hosts"
  at mount time and document it in `docs/channels.md`.

### F3: `docs/nextjs.md` documents a session-ownership guarantee that does not exist

- **Persona:** designer/docs + SE (security expectation mismatch).
- **Evidence:** `docs/nextjs.md:66-68`: "A session id is bound to the first
  authenticated caller that uses it — a different principal gets 403 … and
  `ownsSession` to override it". Neither binding nor `ownsSession` exists —
  `grep ownsSession src/` → nothing; `fetchRoutes.ts` implements only the
  opt-in `authorizeSession` (`fetchRoutes.ts:292-295`), and `docs/auth.md:275`
  itself says "Route auth does not check who owns a session unless you pass
  `authorizeSession`". A reader deploying from `nextjs.md` believes
  cross-user session reads are blocked by default; they are not — any
  authenticated caller who guesses a session id can read/continue it.
- **Suggested fix:** remove the stale paragraph or implement the documented
  first-caller binding (`ownsSession`). At minimum make `nextjs.md` match
  `auth.md`'s "opt-in" wording — this is the difference between a secure
  default and an open one.

---

## Medium

### F4: on Fetch hosts without `waitUntil`, the channel ack waits for the whole turn — Slack/Discord 3s deadlines silently break

- **Persona:** AI engineer (ack semantics) / PM (a Slack bot deployed on a
  plain fetch host loses messages).
- **Evidence:** `settledResponse` in `src/channels/fetchChannels.ts:110-118`:
  when the surface's `respond` wins the race, the turn tail is handed to
  `ctx.waitUntil` *or* `await tail` — so without a `waitUntil` the handler
  resolves only when the turn ends. The ack the channel already "sent" is
  returned late; on a 30s turn Slack's 3s window is blown, Slack retries,
  and the retry is then *dropped* by the `X-Slack-Retry-Num` skip
  (`slackChannel.ts:222`) — the message is silently lost. Docs say the turn
  "runs after the response … within Slack's 3-second limit" without
  qualifying that this needs `ctx.waitUntil` (Vercel/Cloudflare only).
- **Repro:** `audit/eve/channels/r1-ack.ts` — 800ms turn: handler resolves
  in ~827ms without `waitUntil`, 0ms with it.
- **Suggested fix:** warn/document that a fetch host without `waitUntil`
  answers only when the turn ends (or return the ack immediately and accept
  that non-ephemeral hosts — Bun, Deno, Node fetch servers — can safely
  finish the turn in the background; maybe gate the `await tail` on a
  platform signal rather than always).

### F5: GitHub channel posts "Approved by @x" before the decision is validated → false confirmations

- **Persona:** PM/SE — public contradictory output on a visible thread.
- **Evidence:** `readDecision` in `src/channels/githubChannel.ts:397-400`
  posts `Approved by @alice.` via `best()` *before* returning the decision;
  only then does `channelCore` bind it to the session
  (`bindToSession`, `channelCore.ts:212-226`). A stale, made-up, or
  wrong-thread `/approve` id therefore produces "Approved by @alice."
  **and then** "Sorry, that request failed." — the confirmation stands even
  though nothing was decided. Also leaks: `decided`/`prompts` are in-memory
  (`githubChannel.ts:247-250`), so after a restart the thread check is gone
  and only the core binding saves it — but the false comment is already
  posted.
- **Repro:** `audit/eve/channels/r3-github-false-approve.ts` —
  `/approve appr_notreal` from an `OWNER` yields comments
  `['Approved by @alice.', 'Sorry, that request failed.']`.
- **Suggested fix:** post the outcome only after the decision is accepted —
  e.g. return the decision first and let `onDecision`/the continuation's
  `reply` render "Approved by", or re-validate inside `parse` against
  `ctx.approval(id)` + session binding before writing the comment.

### F6: channel 500s leak raw internal error messages; the session routes deliberately redact them

- **Persona:** SE/security — inconsistent error hygiene.
- **Evidence:** `sendFailure` (`src/server/chatRoutes.ts:114-117`) and the
  fetch equivalent (`src/channels/fetchChannels.ts:86-89`) send
  `{ error: error.message }` for *any* failure — including a throwing
  `verify`/`parse`. Meanwhile `fetchRoutes.ts:281-287` specifically hides
  the message behind `PUBLIC_ERROR_MESSAGE` ("provider bodies, chat
  templates" stay in the server log) unless `exposeErrors`. Channel routes
  have no such treatment.
- **Repro:** `audit/eve/channels/r6-7-errors.ts` — a `verify` that throws
  `connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod` is
  answered `500 {"error":"connect ECONNREFUSED postgres://…hunter2…"}`. The
  same leak applies to `mountChannels` (a throwing `verify` → `sendFailure`
  → raw message).
- **Suggested fix:** apply the `PUBLIC_ERROR_MESSAGE` treatment to channel
  500s (keep `SyntaxError`→400 and 413 bodies), log the detail via
  `reportChannelError`.

### F7: two near-simultaneous decisions on one channel approval → the loser gets a 500 / a false "request failed" reply

- **Persona:** SE (idempotency) / PM (double-click UX).
- **Evidence:** `decide()` (`channelCore.ts:294-313`) does `paused.get(id)`,
  then `await audit()` (`onDecision`, which can do real I/O), and only then
  `continueTurn` → `paused.delete` (`channelCore.ts:247`). A second request
  inside that window sees the approval too; both call
  `agent.approvals.resolve` and the loser throws `LOUSHO_APPROVAL_NOT_FOUND`
  → `sendFailure` 500 (before ack) or `reportChannelError` + a "Sorry, that
  request failed." reply (after ack). The session routes solved exactly this
  with `decisionGate` → `409 LOUSHO_APPROVAL_CONFLICT`
  (`fetchRoutes.ts:365-387`); channels have no equivalent.
- **Repro:** `audit/eve/channels/r4b-double-click.ts` — `onDecision` taking
  50ms + two concurrent clicks → statuses `200` and `500`. (Without
  `onDecision` the window is a microtask — effectively unreachable;
  `r4-double-approve.ts` shows the clean 404.)
- **Suggested fix:** atomically claim the decision (`paused.delete` before
  the `await`, or mark it claimed) and map the loser's NOT_FOUND to a
  409/no-op like `decisionGate` does.

### F8: no delivery idempotency — Telegram `update_id` and GitHub `X-GitHub-Delivery` are ignored; Slack's retry skip can drop messages

- **Persona:** SE (replay/idempotency) / PM (delivery guarantees).
- **Evidence:**
  - `telegramChannel.parse` never reads `update_id`
    (`telegramChannel.ts:232-236`). Telegram redelivers an update until it
    gets a 200; if the process crashed mid-turn after acking (or the ack was
    lost), the re-delivery runs the whole turn again — tool side effects
    (emails, refunds) run twice and a second reply is sent.
  - `githubChannel.parse` never reads `X-GitHub-Delivery`
    (`githubChannel.ts:429-438`). GitHub's "redeliver" button (and
    time-outs) re-run the comment as a fresh turn → duplicate comment,
    duplicate tool run.
  - `slackChannel.ts:222` drops *any* `X-Slack-Retry-Num` request; when the
    first delivery never completed a turn (server/LB timeout), the retry —
    the only copy that would run it — is acknowledged and discarded → the
    user's message is silently dropped.
- **Suggested fix:** keep a small dedup set keyed on `update_id` /
  `x-github-delivery` (in-memory is fine for the common crash window;
  TTL'd), and for Slack treat retry-num>0 as "run only if this event id was
  never seen" (`event.ts`/event id) rather than unconditional drop.

### F9: `channel.stream = true` calls `reply()` once per `text.delta` — no batching, ready-made rate-limit footgun

- **Persona:** SE/PM (Telegram/Slack rate limits are per-second).
- **Evidence:** `channelCore.runTurn` (`channelCore.ts:194-199`) invokes
  `channel.reply({partial:true})` inside the `for await` over every delta —
  one call per token chunk, no debounce/throttle. No built-in channel sets
  `stream`, so the only users are custom channel authors, and `docs/channels.md`
  documents the option without warning that wiring it to `chat.postMessage`
  or `sendMessage` produces an API call per token (Slack's limit ~1/s).
- **Suggested fix:** document the call frequency, or coalesce deltas
  (e.g. flush on an interval/min-size and hand the channel a `flush` hint).

### F10: `/channels/<name>/approvals/<id>` and `resolveApproval()` are dead ends after a restart

- **Persona:** AI engineer — the restart story is only half implemented.
- **Evidence:** both paths resolve only the process-local `paused` map
  (`channelCore.ts:265-269`, `294-299`): after a restart (or on a second
  replica) an approval that is still pending in a durable `approvalStore`
  gets a 404 from the route and `LOUSHO_APPROVAL_NOT_FOUND` from
  `handler.resolveApproval`, because a decision without `inbound` has no
  conversation to bind to. Surface clicks carry `inbound` and work; the
  programmatic route — the only recovery path for `httpChannel`/
  `webhookChannel` consumers — does not, even with durable stores.
- **Suggested fix:** document the limitation explicitly (the approvals
  route cannot deliver a continuation for a pause this process forgot), or
  let the approvals body carry the conversation/`sessionKey` so
  `bindToSession` can bind it, as a button's `inbound` does.

---

## Low

### F11: `POST /ui` answers 500 for an invalid chat `id`; `POST /chat` answers 400 for the same id — and `authorizeSession` sees the unvalidated id first

- **Evidence:** `uiChat` (`src/server/routeHandler.ts:85-96`) calls
  `sessionForbidden` then `agent.session({id})`, which throws
  `LOUSHO_SESSION_ID_INVALID` → the catch-all 500. `/chat` validates via
  `openSession`/`assertSessionId` → 400 (`fetchRoutes.ts:298-305`).
- **Repro:** `r6-7-errors.ts` → `/chat` 400, `/ui` 500 for `bad/id!`.
- **Fix:** `assertSessionId(id)` (or `openSession`) before
  `sessionForbidden` in `uiChat`.

### F12: `webhookChannel` defaults to fully open, with no production warning and no session mapping escape hatch

- **Evidence:** `webhookChannel({})` installs `verify` that returns
  `{ok:true}` unconditionally (`webhookChannel.ts:47-48`) — every other
  built-in channel *requires* credentials (Slack/Discord/Telegram/GitHub/
  Teams throw `ConfigurationError` without them), and `createRouteHandler`
  warns in production when `auth` is missing (`routeHandler.ts:79-83`);
  `webhookChannel` does neither. Also: `sessionKey` can only come from the
  JSON body's `sessionKey` field — a sender that can't change its payload
  (fixed-shape hooks) gets a new one-shot session per request, and the
  response (`{...result}`) carries no `sessionId` for the caller to
  correlate (contrast `httpChannel`, which returns `sessionId`).
- **Fix:** warn (or document loudly) when mounted without `auth`/`secret`;
  add a `sessionKey?: (body, req) => string` option and `sessionId` in the
  response.

### F13: Discord signature check has no timestamp freshness — captured requests replay indefinitely

- **Evidence:** `checkSignature` (`discordChannel.ts:82-90`) verifies
  Ed25519 over `timestamp + body` but never checks the timestamp's age —
  unlike Slack's 5-minute window (`slackSignature.ts:31-33`). A captured
  signed interaction can be replayed forever (the interaction token works
  15 min, but the *decision*/PING surface is open to replay at any time).
- **Fix:** reject timestamps older than a few minutes, as Discord's own
  guidance suggests.

### F14: Slack replies are not split and carry no mention protection — inconsistent with every other channel

- **Evidence:** `slackChannel.reply` posts `text` raw
  (`slackChannel.ts:231`); `splitText` is used by Discord (2000), Telegram
  (4096), Teams (25k) and GitHub (60k) but never by Slack — a >40k reply
  fails `msg_too_long` → the user gets the fallback "Sorry, that request
  failed." instead of the answer. Model output can also contain `<!channel>`/
  `@user` mentions — Discord sets `allowed_mentions: {parse: []}`
  (`discordChannel.ts:149`); nothing equivalent exists for Slack/GitHub.
- **Fix:** `splitText(text, ~4000)` (and consider stripping `<!...>`
  broadcast tokens) in the Slack reply.

### F15: product gaps — no rate limiting, no typing indicators, no WhatsApp

- **Persona:** PM. Nothing in `mountChannels`/`fetchChannels`/
  `createRouteHandler`/`createDeployedServer` rate-limits (a public
  `httpChannel`/`webhookChannel` spends model budget at request rate). No
  typing indicator / "…" placeholder exists for any channel — the first
  visible signal is the final reply (Slack's `assistant_threads` status or
  Telegram `sendChatAction` would be the fix). WhatsApp is absent (Discord
  *does* exist — the audit premise there is stale); Twilio/Meta webhooks
  would need `defineChannel` + the `webhookChannel` auth fixes above.
- **Fix:** document a recommended per-`sessionKey`/IP rate-limit hook (or
  ship one as a `mountChannels` option); note `sendChatAction`-style
  hooks in `docs/channels.md`.

### F16: `auth: ''` means lock-everything in `createRouteHandler` but open in `serveFetch`

- **Evidence:** `authList('')` → `[]` → every request 401
  (`routeHandler.ts:71`); `serveFetch` treats `''` as "no auth" → open
  (`fetchRoutes.ts:533`). Same option, opposite failure mode.
- **Fix:** normalize once — an empty token should throw a config error at
  construction, like `assertValidWebhookAuth` does for an empty secret.

### F17: small inconsistencies worth a cleanup pass

- `POST /chat` accepts `input: []` but rejects `''`
  (`fetchRoutes.ts:312` — `Array.isArray` is truthy for an empty array).
- A malformed `%`-escape in a route param throws inside handlers → 500,
  not 400 (`fetchRoutes.ts:511` `decodeURIComponent` in the map;
  `mountChannels.ts:98`).
- `webhookChannel` bodies with no `input` field post the *entire raw body*
  as the user message (`webhookChannel.ts:40`) — including any envelope
  fields; combined with a `newId()` session per request, durable stores
  accumulate one orphan session per call.
- `decide`'s 404 body names the channel
  (`channelCore.ts:298`) — harmless but inconsistent with the generic-401
  philosophy documented in `docs/auth.md`.

---

## Verified non-issues (checked, do not re-report)

- Raw-body signature handling is correct end-to-end: `readRawBody`
  preserves exact bytes, `toChannelRequest.rawBody` is used by every
  signature check (GitHub HMAC-SHA256 with `subtle.verify`, Slack `v0`
  HMAC + 5-min replay window, Discord Ed25519 over `timestamp+body`,
  Teams RS256 JWT + `serviceurl` binding, Telegram constant-time token).
- `POST /chat` disconnect commits the turn (`outliveClient`,
  `fetchRoutes.ts:201-228`) — prior fix confirmed in code.
- `authorizeSession`/`authorizeApproval` cover `/chat`, `/ui`, and
  `POST <base>/approvals/:id` (rewritten to the approval's own session,
  `routeHandler.ts:105-121`).
- Slack `url_verification`, bot-message echoes, retries, and the
  approval-button flow (incl. restart binding via `bindToSession`) all
  behave as documented.
- `1MB` body cap + 413 consistent across `readRawBody`, `readBody` and
  `readRequestBytes`.
