# Sessions

`agent.send(text)` is single-turn: every call starts from an empty history. A
**session** is a multi-turn conversation: it keeps the transcript and passes it
to the model on every `send()`.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const chat = createAgent({ instructions: 'Be brief.', provider });

const session = chat.session(); // in memory, new generated id
await session.send('My name is Ali.');
const { text } = await session.send('What is my name?'); // sees the first exchange

console.log(session.id, session.messages.length);
```

## The session object

| Member | Description |
| ------ | ----------- |
| `id` | The session id: generated (a UUID) unless you pass one. |
| `send(input, { signal })` | Sends a user message with the whole conversation so far and resolves with the usual `ExecutionResult`. |
| `stream(input, { signal })` | Like `send()`, but returns an `AgentRun` that streams the turn as typed events - see [Streaming a session turn](#streaming-a-session-turn). |
| `messages` | A read-only snapshot of the transcript (user, assistant and tool messages; no system prompt). Editing the snapshot does not change the session. |
| `load()` | Reads the saved transcript from the store. `send()` does this for you; call it to show history before the first `send()` of a resumed session. Every call (`load()`, `send()`, `history()`, ...) reads the store again, so turns another session object committed for the same id are seen. |
| `compact(options?)` | Compacts the transcript now - see [Compacting a session](./compaction.md#compacting-a-session). |
| `clear()` | Empties the transcript and saves it empty (the store holds no messages for the id). Keeps the session id, store and options; deletes an interrupted turn's checkpoint; memory slots are cross-session and untouched. Emits `context.cleared` to `on()` listeners. Rejects with `LOUSHO_SESSION_BUSY` while a turn is running, and with `LOUSHO_SESSION_AWAITING_APPROVAL` while a durable turn waits on an approval. |
| `on(listener)` | Listens for the session's events: every turn's events as they happen (`send()` and `stream()` turns, and a paused turn continued by `agent.approvals.resolve()`), plus `compact()` / `clear()` events (`compaction.start`, `compaction.done`, `context.cleared`); returns a function that removes the listener. A turn's events are the `AgentEvent`s its `stream()` yields. |
| `pending()` | In a [durable session](#durable-sessions), the turn that has not finished (`{ status, approvalId?, approvalKind? }`; `approvalKind` is `'question'` when the turn waits on an `ask_question`), or `null`. |
| `resume({ signal })` | In a durable session, finishes an interrupted turn and resolves with its result, or `null` when none is pending. |
| `discardPending()` | In a durable session, drops an unfinished turn without running it. |
| `history()` | The steps of the transcript (one per model response, with its tool calls and results) - see [Forking a session](#forking-a-session). |
| `fork({ fromStep, id?, patch? })` | A new session that starts from this one's transcript up to a step; this session is not changed - see [Forking a session](#forking-a-session). |

Concurrent `send()` calls on one session are queued and run one after another in
call order, so the transcript never interleaves.

`agent.session({ id, turnPolicy })` chooses what a `send()` or `stream()` does
while a turn is running or waiting to start:

- `'wait'` (the default): it waits and runs as its own turn, as above.
- `'queue'`: its input joins that turn, like
  [`run.enqueue()`](./queue-and-steer.md#queued-input): it is added after the
  current step's tool results and the turn's next model call sees it. The call
  resolves with that turn's result (its own `signal` does not apply to the
  turn), and the transcript saved when the turn ends holds the queued user
  message in order. A joining `stream()` yields only the turn's `run.done`;
  the turn's events, `input.queued` and `input.applied` included, stream on
  the run that started it. If the turn ends before it could take the input
  (it finished, paused or was aborted), the call runs as the next turn after
  all — except in a durable session whose paused turn is still pending:
  there the call first resumes it, and rejects with
  `SessionAwaitingApprovalError` when it is still waiting on the approval
  (decide it with `agent.approvals.resolve()`). If the turn fails, the call
  rejects with the same error; in a durable
  session the input stays in the turn's checkpoint and `resume()` applies it.
- `'steer'`: like `'queue'`, but the input joins through
  [`run.steer()`](./queue-and-steer.md#steering): if the turn's model call has not
  emitted anything yet, it is aborted and made again with the new message, and
  tool calls of the turn that have not started are not run. Otherwise it waits
  for the next safe point, as with `'queue'`. The call resolves with the
  turn's result, and the same fallbacks apply.

The `vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const session = agent.session({ id: 'user-42', turnPolicy: 'queue' });

const first = session.send('Find flights to Rome.');
const second = session.send('Only direct ones, please.'); // joins the first turn
console.log((await second) === (await first)); // true: one turn, one result
```

`send()` and `stream()` take a string, content parts (`[{ type: 'text', ... }, { type: 'image', ... }]`, one user message) or a `Message[]`; the stores keep the parts, see [Multimodal input](./providers.md#multimodal-input).

A `send()` that throws (a provider error, or a tool that throws a
`PropagatingToolError`) or is aborted with `signal` leaves the transcript
exactly as it was before that call, with one exception: an aborted `send()`
keeps the turn up to the last tool call that ran (its user message, the
assistant's tool calls and their results; calls of that batch that never
started keep a "cancelled" result), so a side effect such as a refund is never
missing from the transcript. An aborted `send()` resolves with
`finishReason: 'aborted'`, as `agent.send()` does. The stored transcript never
contains an assistant tool-call turn without the matching tool results.

A `send()` that pauses on a `needsApproval` tool resolves with
`finishReason: 'awaiting-approval'`. `agent.approvals.resolve({ id, approved })`
then continues the run as the session's next turn, so the tool call, its result
and the final answer join the transcript (see
[Approvals](./approvals.md)).

`agent.session({ id, limits })` sets budgets across all of the session's turns
(for example `{ maxCostUsd: 1 }`), counted from the usage saved with the
transcript; `createAgent({ limits })` limits each turn on its own. See
[Budgets](./configuration.md#budgets).

## Streaming a session turn

`session.stream(input, { signal })` is `agent.stream()` for a conversation: it
returns the same `AgentRun` (typed events plus a `result` promise, see
[Streaming](./streaming.md)), but the turn sees the transcript so far and joins
it.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const chat = createAgent({ instructions: 'Be brief.', provider });
const session = chat.session();

for await (const event of session.stream('My name is Ali.')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
// The turn is already saved: this call sees it.
const { text } = await session.send('What is my name?');
```

- It builds the same message list as `send()` and queues behind earlier calls
  on the session (`send()` and `stream()` can be mixed).
- When the run ends, the new user message and the run's output are saved
  exactly as `send()` saves them, and only then is `run.done` delivered. When
  the `for await` loop ends, or `run.result` resolves, the transcript is
  complete. The events carry the `runId` of the returned handle.
- An aborted run (`signal`, or breaking out of the loop early) or a failed one
  leaves the transcript as it was before the call, like `send()` (an aborted
  run keeps the tool calls that ran). A run that
  was already finished when the loop was left is saved. A failed run ends the
  stream with `error` and `run.done` (`finishReason: 'error'`), and
  `run.result` rejects. This includes a store that fails to load or save: the
  turn then has no `run.start`.
- A run that pauses on a `needsApproval` tool ends with `approval.requested`
  and `run.done` (`'awaiting-approval'`), exactly as `send()` resolves, and the
  transcript holds the turn up to the pause. `agent.approvals.resolve()`
  continues it as the session's next turn. An `approve` callback does not apply
  to streams, as with `agent.stream()`.

Sessions are a thin layer: the session owns the transcript and hands it to the
executor on each turn. Without a checkpoint store, a turn is saved only when it
ends, so a crash in the middle of a turn loses it; see the next section.

## Durable sessions

Give the agent a `store` with checkpoints and every session turn is
checkpointed after each model response and tool result, using the
[durable execution](./durable-execution.md) mechanism. A turn interrupted by a
crash, a failed checkpoint write or a `PropagatingToolError` can then be
finished later, in another process:

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const agent = createAgent({ provider, store: new SqliteStore('./.lousho/agent.db') });

// After a restart: finish the turn that was running, if any.
const finished = await agent.resume('user-42'); // ExecutionResult, or null when nothing was pending
console.log(finished?.text, await agent.session({ id: 'user-42' }).pending()); // pending() is null now
```

- `createAgent({ store })` takes any `AgentStore`
  (`{ sessions?, checkpoints?, approvals? }`, see [Choosing a store](#choosing-a-store)):
  `agent.session({ id })` keeps its transcript in `store.sessions` and
  checkpoints in `store.checkpoints`, and `store.approvals` holds approval
  pauses. A session's own `store` (a `SessionStore`, or a
  `{ sessions, checkpoints }` object) and `checkpointStore` win over the
  agent's, part by part.
- `agent.resume(id)` is `agent.session({ id }).resume()`, except that it first
  finishes a run started with `agent.send(message, { sessionId: id })` (see
  [Durable execution](./durable-execution.md)).
- Each turn runs with `sessionId: '<session id>.turn-<n>'` (`n` is the length
  of the transcript when the turn started), so a new process finds the
  interrupted turn without any extra bookkeeping. A finished turn joins the
  transcript, exactly as a plain `send()` does, and its checkpoint is deleted.
- `resume()` continues the turn through the executor's resume path
  (`input: []`): tool calls whose results were recorded do not run again, and
  a recorded model response is not requested again. A tool that was running
  when the process died does run again (at-least-once, see
  [Durable execution](./durable-execution.md#at-least-once-tools-make-side-effects-idempotent)).
- `send()` and `stream()` resume a pending turn first, then send the new
  message, so the model sees the finished turn (the resumed turn's events are
  not streamed). Use `pending()` to check first, or `discardPending()` to drop
  the unfinished turn instead.
- A turn that pauses on a `needsApproval` tool stays in its checkpoint, not in
  the transcript, until it finishes. While it waits, `resume()`, `send()` and
  `stream()` throw `SessionAwaitingApprovalError` (with its `approvalId`), and
  `agent.approvals.resolve({ id, approved })` continues the turn in this
  session. After a restart, open the session and call `resume()` (or `send()`)
  once before resolving, so the agent knows which session the approval belongs
  to; give both agents the same durable `store` (or `approvalStore`).
- An aborted turn is dropped (its checkpoint is deleted), as without a
  checkpoint store, except for the tool calls that ran in it, which join the
  transcript. `clear()` deletes a pending turn too.

## Stores

A `SessionStore` keeps transcripts between calls:

```ts
import type { Message } from '@lousho/build-ai-agent';

interface SessionStore {
  load(id: string): Promise<Message[] | undefined>;
  save(id: string, messages: readonly Message[]): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- `MemorySessionStore` (the default, one new store per session) lives as long as
  the process. Share one instance between sessions to look them up by id.
- `FileSessionStore(dir)` writes one JSON file per session (`<dir>/<id>.json`),
  atomically (temp file, then rename), creating `dir` on first save.

```ts
import { createAgent, FileSessionStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider });
const store = new FileSessionStore('./.lousho/sessions');

const first = agent.session({ id: 'user-42', store });
await first.send('My name is Ali.');

// Later, even in another process or another createAgent() instance:
const again = agent.session({ id: 'user-42', store });
await again.send('What is my name?'); // "Ali"
```

Session ids must match `^[A-Za-z0-9_-]{1,128}$` (they become file names, so
`../x` and `a/b` are refused with an error that says so). Implement
`SessionStore` yourself to keep transcripts in a database or Redis.

An `AgentStore` has a fourth optional part next to `sessions`, `checkpoints`
and `approvals`: `tokens`, the OAuth access and refresh tokens of tools and
connections, kept encrypted by the file, SQLite and KV stores (see
[OAuth](oauth.md#token-storage)).

## Choosing a store

Sessions, durable-execution checkpoints and approvals each have a store
interface (`SessionStore`, `CheckpointStore`, `ApprovalStore`). Pick the
implementation by where the process runs:

| Store | Sessions | Checkpoints | Approvals | Use it when |
| --- | --- | --- | --- | --- |
| In memory (`memoryStore()`) | `MemorySessionStore` | in memory | `InMemoryApprovalStore` | Tests, scripts, one process that never restarts |
| Files (`fileStore(dir)`) | `<dir>/sessions/<id>.json` | `<dir>/checkpoints/`, `<dir>/checkpoint-history/` | `<dir>/approvals/<id>.json` | One machine, you want plain inspectable files |
| SQLite | `store.sessions` | `store.checkpoints` | `store.approvals` | A Node server: one durable, transactional file, shared safely by several processes |
| Cloudflare KV (`KVStore` from `@lousho/build-ai-agent/kv`) | `store.sessions` | `store.checkpoints` | `store.approvals` | Workers deployments (see [Deployment](deployment.md)) |

Each one is an `AgentStore` part: pass them together as
`createAgent({ store: { sessions, checkpoints, approvals } })`. `memoryStore()`,
`fileStore(dir)`, `SqliteStore` and `KVStore` are ready-made `AgentStore`s. For
plain files, `fileStore(dir)` writes one JSON file per session, checkpoint and
pending approval under `dir`, each written to a temp file and renamed into
place, with no lock files:

```ts
import { createAgent, fileStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: fileStore('./.lousho') });
// ./.lousho/sessions/user-42.json, ./.lousho/checkpoints/..., ./.lousho/approvals/...
await agent.session({ id: 'user-42' }).send('Hello');
```

Each `checkpoints/<id>.json` has a `checkpoint-history/<id>.json` next to it:
the checkpoint's bounded history, oldest first. Directories are created on
first write, so `approvals/` (and `oauth/`) only appear after the first pending
approval (or sign-in).

Resolving an approval from `fileStore` is safe across processes (only one
caller gets the record); two processes writing one session at the same moment
are not coordinated, so the last write wins. For several processes sharing a
store, use `SqliteStore`.

Any object with the three methods of a part works there too: a Redis
`SessionStore`, or a KV-backed `CheckpointStore` on Cloudflare Workers (the
generated Worker uses `KVCheckpointStore`, see [Deployment](deployment.md)).

`SqliteStore` keeps all three in one database file, using Node's built-in
`node:sqlite` (no native dependency; needs Node 22.13 or newer, and it is not
re-exported from the root entry, so importing the SDK never loads it):

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db'); // or ':memory:'
const agent = createAgent({ provider, store }); // transcripts, per-step checkpoints and approvals
await agent.session({ id: 'user-42' }).send('Hello');

store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000 }); // { sessions, checkpoints, approvals, oauthPending } deleted
store.close();
```

With the executor directly, pass `store.checkpoints` as `checkpointStore` and
`store.approvals` as `approvalStore`; see [the executor API](./executor-api.md).

- The directory is created if missing. The schema is versioned with
  `PRAGMA user_version` and migrated on open; a database written by a newer
  release is refused.
- WAL mode and a 5 s busy timeout let two processes share the file. An approval
  can be resolved by only one of them.
- Checkpoints and approval snapshots are stored as opaque JSON, so new fields
  round-trip unchanged.
- `prune()` removes sessions and checkpoints not updated within `olderThanMs`,
  approvals resolved that long ago and expired pending OAuth sign-ins;
  unresolved approvals and OAuth tokens are kept.
- A file that is not a SQLite database fails with an error naming the path;
  using the store after `close()` throws a clear error.

## Project instructions

Not part of sessions, but often wanted together: see "Project instructions" in
[Configuration](configuration.md) to give an agent your repository's
`AGENTS.md`.

## Forking a session

`session.history()` lists the steps of a session, and `session.fork({ fromStep })`
starts a new session from any of them, so you can try another direction
without losing the original conversation:

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const searchFlights = defineTool({
  name: 'search_flights',
  description: 'Find flights to a city',
  input: z.object({ to: z.string() }),
  execute: async ({ to }) => `2 flights to ${to}`,
});
const agent = createAgent({
  tools: [searchFlights],
  provider: mockModel([
    { toolCalls: [{ name: 'search_flights', args: { to: 'Lisbon' } }] },
    'Two flights to Lisbon on Friday.',
    'Porto has a direct flight at 9:00.',
  ]),
});
const session = agent.session({ id: 'trip' });
await session.send('Find me a flight to Lisbon on Friday.');

for (const { step, turn, text, toolCalls } of await session.history()) {
  console.log(step, turn, text, toolCalls.map((call) => `${call.name} -> ${call.result}`));
}

// Keep everything up to and including step 1, then go another way.
const fork = await session.fork({ fromStep: 1 }); // saved in the same store
const reply = await fork.send('Look at Porto instead.');
console.log(fork.id, reply.text); // 'trip-fork-1', 'Porto has a direct flight at 9:00.'
```

- A **step** is one model response in the transcript: an assistant message,
  plus the tool messages answering its tool calls. `history()` returns
  `{ step, turn, messageIndex, text, toolCalls }` for each, oldest first:
  `step` is numbered from 1 across the whole session (not per turn), `turn`
  from 0, `messageIndex` is the assistant message's index in
  `session.messages`, and each tool call has its `id`, `name`, parsed `args`
  (the raw string when it is not JSON) and `result` (the tool message's
  content as text, JSON-encoded as the model saw it). The steps are copies.
- A **turn** starts at every user message, so a step's `turn` is the 0-based
  index of the user message it answers, the same numbering as workspace
  rewind uses. Input queued or steered into a running turn
  (`turnPolicy: 'queue'` or `'steer'`) is a user message too, so it starts a
  new turn in `history()`.
- `history()` is the history of the current transcript: after
  `session.compact()` the steps are renumbered from the compacted transcript.
  A durable turn that has not finished is not in the transcript yet, so it is
  not listed.
- `fork({ fromStep })` keeps the transcript up to and including the step's
  last tool message; `fromStep: 0` keeps nothing. A step outside
  `0..history().length` is refused with
  [`LOUSHO_SESSION_STEP_NOT_FOUND`](./errors.md#lousho_session_step_not_found),
  whose message lists the valid range.
- `patch: { toolResult: { toolCallId, result } }` replaces the result of one
  tool call in the kept transcript ("what if the search had found nothing?"),
  the same way as `agent.fork()`'s patch.
- The fork is saved in the session's own store and is a session of the same
  agent with the same options (`store`, checkpoints, `limits`, `turnPolicy`,
  `compaction`, and the [permission mode](./permission-modes.md) the session
  has when it forks), so streaming, approvals and checkpointed turns work as on any
  `agent.session()`, and `agent.session({ id: fork.id, store })` continues it
  later, in another process too. Its id is `id` when you pass one, else
  `<id>-fork-<n>` for the first `n` from 1 that has no transcript. An `id` that
  already has a transcript (or the session's own id) is refused with
  [`LOUSHO_SESSION_EXISTS`](./errors.md#lousho_session_exists).
- The original session's transcript and checkpoints are not changed.
- Budgets: the spend recorded for `limits` stays on the kept messages, so a
  fork's `limits` start from what the session had spent at the end of the last
  turn it keeps (a turn records its spend on its last message).
- `fork()` waits for queued calls, and rejects with `LOUSHO_SESSION_BUSY` while
  a turn is running.
- A paused session can be forked. The paused turn, its approval or
  `ask_question` and a durable session's interrupted turn stay with the source
  session: the fork has no pending turn, and `agent.approvals.resolve()`
  continues the source only, once.
- Only the conversation is forked. Files the agent wrote and other side
  effects of the steps after the fork point are not undone; to restore
  workspace files, see the rewind part of [Workspace tools](./workspace-tools.md).

To fork a single run started with `agent.send(message, { sessionId })`, from
its checkpoint history, use `agent.fork()` instead (see
[Fork and replay](./durable-execution.md#fork-and-replay)).
