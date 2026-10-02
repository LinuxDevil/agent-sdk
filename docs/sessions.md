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
| `load()` | Reads the saved transcript from the store. `send()` does this for you; call it to show history before the first `send()` of a resumed session. |
| `compact(options?)` | Compacts the transcript now - see [Compacting a session](./compaction.md#compacting-a-session). |
| `clear()` | Empties the transcript and saves it empty (the store holds no messages for the id). Keeps the session id, store and options; deletes an interrupted turn's checkpoint; memory slots are cross-session and untouched. Emits `context.cleared` to `on()` listeners. Rejects with `LOUSHO_SESSION_BUSY` while a turn is running, and with `LOUSHO_SESSION_AWAITING_APPROVAL` while a durable turn waits on an approval. |
| `on(listener)` | Listens for `compact()` / `clear()` events (`compaction.start`, `compaction.done`, `context.cleared`); returns a function that removes the listener. |
| `pending()` | In a [durable session](#durable-sessions), the turn that has not finished (`{ status, approvalId? }`), or `null`. |
| `resume({ signal })` | In a durable session, finishes an interrupted turn and resolves with its result, or `null` when none is pending. |
| `discardPending()` | In a durable session, drops an unfinished turn without running it. |

Concurrent `send()` calls on one session are queued and run one after another in
call order, so the transcript never interleaves.

`agent.session({ id, turnPolicy })` chooses what a `send()` or `stream()` does
while a turn is running or waiting to start:

- `'wait'` (the default): it waits and runs as its own turn, as above.
- `'queue'`: its input joins that turn, like
  [`run.enqueue()`](./streaming.md#queued-input): it is added after the
  current step's tool results and the turn's next model call sees it. The call
  resolves with that turn's result (its own `signal` does not apply to the
  turn), and the transcript saved when the turn ends holds the queued user
  message in order. A joining `stream()` yields only the turn's `run.done`;
  the turn's events, `input.queued` and `input.applied` included, stream on
  the run that started it. If the turn ends before it could take the input
  (it finished, paused or was aborted), the call runs as the next turn after
  all. If the turn fails, the call rejects with the same error; in a durable
  session the input stays in the turn's checkpoint and `resume()` applies it.
- `'steer'`: like `'queue'`, but the input joins through
  [`run.steer()`](./streaming.md#steering): if the turn's model call has not
  emitted anything yet, it is aborted and made again with the new message, and
  tool calls of the turn that have not started are not run. Otherwise it waits
  for the next safe point, as with `'queue'`. The call resolves with the
  turn's result, and the same fallbacks apply.

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
exactly as it was before that call. An aborted `send()` resolves with
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
  leaves the transcript as it was before the call, like `send()`. A run that
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
  checkpoint store. `clear()` deletes a pending turn too.

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
import { createAgent, AgentExecutor } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db'); // or ':memory:'
const agent = createAgent({ provider, store }); // transcripts, per-step checkpoints and approvals
await agent.session({ id: 'user-42' }).send('Hello');

// With AgentExecutor directly, pass the parts:
// AgentExecutor.execute({ ..., sessionId, checkpointStore: store.checkpoints, approvalStore: store.approvals })

store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000 }); // { sessions, checkpoints, approvals } deleted
store.close();
```

- The directory is created if missing. The schema is versioned with
  `PRAGMA user_version` and migrated on open; a database written by a newer
  release is refused.
- WAL mode and a 5 s busy timeout let two processes share the file. An approval
  can be resolved by only one of them.
- Checkpoints and approval snapshots are stored as opaque JSON, so new fields
  round-trip unchanged.
- `prune()` removes sessions and checkpoints not updated within `olderThanMs`,
  and approvals resolved that long ago; unresolved approvals are kept.
- A file that is not a SQLite database fails with an error naming the path;
  using the store after `close()` throws a clear error.

## Project instructions

Not part of sessions, but often wanted together: see "Project instructions" in
[Configuration](configuration.md) to give an agent your repository's
`AGENTS.md`.
