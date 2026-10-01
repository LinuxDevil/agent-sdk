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

Sessions are a thin layer: the session owns the transcript and hands it to the
executor on each turn. They do not use the checkpoint/resume mechanism
(`sessionId` + `checkpointStore` on `AgentExecutor.execute()`), which is for
resuming one interrupted run, not for continuing a conversation.

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

## Project instructions

Not part of sessions, but often wanted together: see "Project instructions" in
[Configuration](configuration.md) to give an agent your repository's
`AGENTS.md`.
