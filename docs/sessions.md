# Sessions

`agent.send(text)` is single-turn: every call starts from an empty history. A
**session** is a multi-turn conversation: it keeps the transcript and passes it
to the model on every `send()`.

```ts
import { createAgent } from '@loushy/build-ai-agent';

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
| `clear()` | Forgets the conversation, including in the store. |
| `pending()` | In a [durable session](#durable-sessions), the turn that has not finished (`{ status, approvalId? }`), or `null`. |
| `resume({ signal })` | In a durable session, finishes an interrupted turn and resolves with its result, or `null` when none is pending. |
| `discardPending()` | In a durable session, drops an unfinished turn without running it. |

Concurrent `send()` calls on one session are queued and run one after another in
call order, so the transcript never interleaves.

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

## Streaming a session turn

`session.stream(input, { signal })` is `agent.stream()` for a conversation: it
returns the same `AgentRun` (typed events plus a `result` promise, see
[Streaming](./streaming.md)), but the turn sees the transcript so far and joins
it.

```ts
import { createAgent } from '@loushy/build-ai-agent';

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

Give the session a `CheckpointStore` and every turn is checkpointed after each
model response and tool result, using the [durable execution](./durable-execution.md)
mechanism. A turn interrupted by a crash, a failed checkpoint write or a
`PropagatingToolError` can then be finished later, in another process:

```ts
import { createAgent, FileSessionStore, type CheckpointStore } from '@loushy/build-ai-agent';

declare const checkpointStore: CheckpointStore; // e.g. LocalStorageCheckpointStore, or SqliteStore's `checkpoints`

const agent = createAgent({ provider });
const store = new FileSessionStore('./.loushy/sessions');

// After a restart: finish the turn that was running, if any.
const session = agent.session({ id: 'user-42', store, checkpointStore });
const finished = await session.resume(); // ExecutionResult, or null when nothing was pending
console.log(finished?.text, await session.pending()); // pending() is null now
```

- Pass `checkpointStore`, or a `store` that carries both stores: any
  `{ sessions, checkpoints }` object, such as a `SqliteStore`
  (`agent.session({ id, store: sqliteStore })`).
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
  to; give both agents the same durable `approvalStore`.
- An aborted turn is dropped (its checkpoint is deleted), as without a
  checkpoint store. `clear()` deletes a pending turn too.

## Stores

A `SessionStore` keeps transcripts between calls:

```ts
import type { Message } from '@loushy/build-ai-agent';

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
import { createAgent, FileSessionStore } from '@loushy/build-ai-agent';

const agent = createAgent({ provider });
const store = new FileSessionStore('./.loushy/sessions');

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
| In memory | `MemorySessionStore` | (supply your own) | `InMemoryApprovalStore` | Tests, scripts, one process that never restarts |
| Files | `FileSessionStore(dir)` | `LocalStorageCheckpointStore` | `StorageServiceApprovalStore` | One machine, you want plain inspectable files |
| SQLite | `store.sessions` | `store.checkpoints` | `store.approvals` | A Node server: one durable, transactional file, shared safely by several processes |
| Cloudflare KV | - | `KVCheckpointStore` | - | Workers deployments (see [Deployment](deployment.md)) |

`SqliteStore` keeps all three in one database file, using Node's built-in
`node:sqlite` (no native dependency; needs Node 22.13 or newer, and it is not
re-exported from the root entry, so importing the SDK never loads it):

```ts
import { createAgent, AgentExecutor } from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const store = new SqliteStore('./.loushy/agent.db'); // or ':memory:'
const session = createAgent({ provider }).session({ id: 'user-42', store }); // transcript + per-step checkpoints
await session.send('Hello');

// Same file, same store, for durable runs with approvals:
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
