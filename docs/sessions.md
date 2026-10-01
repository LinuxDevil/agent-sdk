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
| `messages` | A read-only snapshot of the transcript (user, assistant and tool messages; no system prompt). Editing the snapshot does not change the session. |
| `load()` | Reads the saved transcript from the store. `send()` does this for you; call it to show history before the first `send()` of a resumed session. |
| `clear()` | Forgets the conversation, including in the store. |

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
[approval gates](../README.md#human-in-the-loop-approval-gates)).

Sessions are a thin layer: the session owns the transcript and hands it to the
executor on each turn. They do not use the checkpoint/resume mechanism
(`sessionId` + `checkpointStore` on `AgentExecutor.execute()`). That lower-level
mechanism also continues a finished conversation, and additionally resumes a
run interrupted mid-turn (a crash, an abort, an approval pause) without
re-running finished tools - see [Durable execution](./durable-execution.md).

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

## Stores

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
const session = createAgent({ provider }).session({ id: 'user-42', store: store.sessions });
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
