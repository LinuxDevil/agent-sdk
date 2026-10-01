# Durable execution

Pass a `sessionId` and a `checkpointStore` to `AgentExecutor.execute()` and
the run survives a crash, a restart, an abort or a human approval that takes
days. Nothing here depends on a particular host: any `CheckpointStore`
(`LocalStorageCheckpointStore` on Node, the Cloudflare KV store the
`cloudflare-worker` build wires up, or your own three-method implementation)
and any `ApprovalStore` work the same way.

```ts
import { AgentExecutor, LocalStorageCheckpointStore } from '@loushy/build-ai-agent';

const checkpoints = new LocalStorageCheckpointStore(storage);

// First message of a conversation.
await AgentExecutor.execute({ agent, input: 'Book a table for 2 tonight', provider, sessionId: 'chat-42', checkpointStore: checkpoints });

// Later - same process or another one - the next message of the same conversation.
await AgentExecutor.execute({ agent, input: 'Make it 3 people', provider, sessionId: 'chat-42', checkpointStore: checkpoints });
```

With `createAgent()`, one `store` option does the wiring: pass a `sessionId` to
`send()` (or `stream()`) and the run is checkpointed in `store.checkpoints`;
after a crash, `agent.resume(sessionId)` finishes it (and returns `null` when
nothing is pending). No `AgentExecutor` needed:

```ts
import { createAgent } from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const agent = createAgent({ provider, store: new SqliteStore('./.loushy/jobs.db') });

const finished = await agent.resume('job-1'); // the interrupted run, if any
const next = await agent.send('Now write a summary', { sessionId: 'job-1' }); // continues the same run's conversation
```

`store.approvals` holds approval pauses, and `agent.approvals.resolve()`
keeps checkpointing the run under its `sessionId`. Sessions are checkpointed
too: `agent.session({ id })` checkpoints every turn and `agent.resume(id)` (or
`session.resume()`) finishes an interrupted one - see
[Durable sessions](./sessions.md#durable-sessions).

## What is checkpointed, and when

A checkpoint is the run's whole transcript plus its step count, usage,
`businessState` and a `status`. It is written under the `sessionId`:

| Moment | `status` |
| ------ | -------- |
| Right after each model response that asks for tools, before any tool runs | `'in-progress'` |
| Each time a tool result is recorded (results are recorded in call order) | `'in-progress'` |
| When the run is aborted (`signal`) | `'in-progress'` |
| When the run pauses for an approval (its own tool call's, or a [sub-agent](sub-agents.md)'s, also when a resumed sub-agent pauses again) | `'awaiting-approval'` (with `approvalId`) |
| When the run finishes (the model stopped calling tools, or `maxSteps` ran out) | `'finished'` |

A run that rejects (a provider error, a throwing hook, a
`PropagatingToolError`, a process crash) keeps its last `'in-progress'`
checkpoint.

## What happens when you call `execute()` again with the same `sessionId`

It depends on the stored `status`:

- **Unfinished run** (`'in-progress'`: it crashed, was aborted, or a store
  write failed). The run resumes. If its last model turn has tool calls
  without a result, exactly those calls run first, through the normal tool
  path (argument validation, hooks, `needsApproval`, `toolConcurrency`),
  **without calling the model again**. Then the loop continues, with the
  remaining `maxSteps` budget; `usage` continues from the checkpointed
  totals (the same holds for `resumeAfterApproval()`, from the snapshot).
  - New `input` is appended as a user message after those tool results.
    It is never placed between a tool-call turn and its results, so the
    transcript stays valid for every provider. This is what lets a user
    interrupt a run (abort it) and redirect it with a new message.
  - `input` that re-sends the message the run started from (the natural
    "retry the same request after a crash") is treated as a retry and is
    not appended again. `input: []` also just resumes.
- **Finished run** (`'finished'`). The session continues as a conversation:
  the stored messages are kept and `input` becomes the next user turn. Pass
  only the new message(s); if you re-send the stored history followed by
  new messages, the history is recognised and not duplicated. `steps`,
  `usage` and `toolCalls` on the result count from zero for the new run;
  `messages` is the whole conversation.
- **Paused awaiting approval** (`'awaiting-approval'`). `execute()` throws
  `SessionAwaitingApprovalError` (with `sessionId` and `approvalId`) and
  does not call the model or any tool: new input must not bypass a pending
  decision. Resolve it with `resumeAfterApproval()` first, passing the same
  `checkpointStore`, then send the new message.

System messages in `input` are ignored when it is added to a stored
session (the session already has its system prompt). To end a session and
start over under the same id, call `checkpointStore.delete(sessionId)`.

```ts
import { AgentExecutor, SessionAwaitingApprovalError } from '@loushy/build-ai-agent';

try {
  await AgentExecutor.execute({ agent, input: 'Are you done?', provider, sessionId: 'chat-42', checkpointStore });
} catch (error) {
  if (error instanceof SessionAwaitingApprovalError) {
    console.log(`Waiting on approval ${error.approvalId} - resolve it with resumeAfterApproval() first.`);
  }
}
```

## Approvals in the middle of a tool batch

When one model turn asks for several tools and one of them needs approval,
the calls before it run and are recorded, and the run pauses on it. The
approval snapshot records the calls after it (`remainingToolCalls`).
`resumeAfterApproval()` then:

1. records the paused call's result - the tool's result if approved, or a
   structured `{ error, note }` rejection result if rejected;
2. runs the remaining calls through the same batch logic: they can run,
   fail validation, or pause the run again on another approval (a new
   `approvalId`; resolve it the same way, as many times as needed);
3. calls the model once every call of the turn has exactly one result.

```ts
import { AgentExecutor, resumeAfterApproval } from '@loushy/build-ai-agent';

const paused = await AgentExecutor.execute({
  agent, input, provider, toolRegistry, approvalStore, sessionId: 'chat-42', checkpointStore,
});

if (paused.finishReason === 'awaiting-approval') {
  // ...a human decides, possibly days later, in another process...
  const result = await resumeAfterApproval(
    { id: paused.approvalId!, approved: true },
    approvalStore,
    toolRegistry,
    provider,
    {},
    checkpointStore, // clears the 'awaiting-approval' mark and keeps checkpointing
  );
  console.log(result.finishReason); // 'stop', or 'awaiting-approval' again for the next gated call
}
```

The resumed run uses the same `approvalStore` for any later approval unless
you pass a different one in the options.

## Guarantees

- **Every tool call gets exactly one result, in call order**, after any
  sequence of crashes, aborts, pauses and resumes. (An aborted call gets a
  "cancelled" result; a rejected call gets a rejection result.)
- **A recorded result is never re-executed.** Results are checkpointed as
  the in-order prefix of finished calls grows; a resumed run only runs calls
  that have no recorded result.
- **A checkpointed model turn is never generated again.** If the process
  dies after the model answered, the resumed run executes that answer's tool
  calls instead of asking the model again (no extra cost, no different
  plan).
- **The provider always receives a valid transcript**: tool results
  directly follow their tool-call turn, and new user input comes after them.

## At-least-once tools: make side effects idempotent

A tool that was **running** when the process died has no recorded result,
so it runs again on resume. Tool execution is therefore at-least-once, not
exactly-once. For tools with side effects (charging a card, sending an
email), either gate them with `needsApproval` or make them idempotent.
Each call's `toolCallId` (the model's id for the call, unchanged when it is
re-run on resume) is passed to `execute`, so it works as an idempotency
key:

```ts
import { defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

declare const payments: { charge(amount: number, opts: { idempotencyKey: string }): Promise<{ id: string }> };

const chargeCard = defineTool({
  name: 'charge_card',
  description: 'Charge the customer',
  input: z.object({ amount: z.number() }),
  execute: async ({ amount }, { toolCallId }) =>
    payments.charge(amount, { idempotencyKey: toolCallId }), // a re-run cannot charge twice
});
```

(`toolCallId` is set for tools run by `AgentExecutor` and by
`resumeAfterApproval()`, but not yet for tools that route through
`sandboxExecute`.)

## Checkpoint history

A checkpoint record is overwritten on every save, so the run's earlier steps are
gone once it moves on. A store can also keep a bounded history per session:
every `save()` appends the record to a ring (the newest `historyLimit` saves,
default 50; the oldest are dropped), which is what replaying or forking a run
from an earlier step is built on.

Which stores keep one:

| Store | History | Option |
| --- | --- | --- |
| `memoryStore()` | yes | `memoryStore({ historyLimit })` |
| `SqliteStore` | yes (`checkpoint_history` table) | `new SqliteStore(path, { historyLimit })` |
| `LocalStorageCheckpointStore` | yes | `new LocalStorageCheckpointStore(storage, { historyLimit })` |
| `KVCheckpointStore` / `KVStore` (Cloudflare Workers KV) | yes (see below) | `new KVStore(kv, { historyLimit })` |
| Agent Forge's `FileCheckpointStore` | yes | `new FileCheckpointStore(dir, { historyLimit })` |
| a custom `CheckpointStore` | only if it implements `history()` | - |

For example, with the in-memory store:

```ts
import { getCheckpointHistory, memoryStore } from '@loushy/build-ai-agent';

const { checkpoints } = memoryStore({ historyLimit: 20 }); // default 50, 0 keeps none
// new SqliteStore(path, { historyLimit }), new LocalStorageCheckpointStore(storage, { historyLimit })

// ... after a run with sessionId 'chat-42' ...
const history = await getCheckpointHistory(checkpoints, 'chat-42', { limit: 10 });
for (const { step, savedAt, status, checkpoint } of history ?? []) {
  console.log(step, status, savedAt, checkpoint.messages.length);
}

// Clear the checkpoint but keep its history (by default delete() clears both).
await checkpoints.delete('chat-42', { keepHistory: true });
```

- `history(sessionId, { limit? })` returns `{ step, savedAt, status, checkpoint }`
  entries, newest first (`step` is `checkpoint.stepIndex`, `savedAt` an ISO
  timestamp, `status` is `'in-progress'` for a checkpoint without one). The
  executor saves after every model turn and tool batch, so a session has one
  entry per save; the entries hold full checkpoints, so lower `historyLimit`
  for long transcripts. An unknown session gives `[]`.
- `history` is optional on `CheckpointStore`: a custom store without it keeps
  working, and `getCheckpointHistory()` returns `undefined` for it instead of
  throwing.
- `KVCheckpointStore` keeps one index key per session
  (`<prefix><sessionId>#history`, the entry ids oldest first) and one key per
  entry (`<prefix><sessionId>#history/<id>`), so no value grows with the
  history; the latest checkpoint stays at `<prefix><sessionId>`, so a store
  written before history existed still loads. A save writes the checkpoint,
  then the entry, then the index, then deletes the entries it dropped: a crash
  between writes leaves an unlisted entry at worst (it expires with the TTL),
  never an unreadable store. KV has no transactions, so two concurrent saves of
  one session can lose one index update (that entry is missing from
  `history()`), and an entry can be missing for a while at another edge
  location (eventual consistency; `history()` skips it). Route a session's
  requests to one location when that matters. Each save costs one `get` and two
  `put`s more; `historyLimit: 0` turns it off.
- Agent Forge's file store writes the history as one file per session
  (`.loushy/agents/<id>/checkpoint-history/<session>.json`, replaced
  atomically); a file damaged by a crash reads as no history and is rebuilt by
  the next save.
- `SqliteStore` keeps the history in a new `checkpoint_history` table, added when
  an existing database file is opened; `prune()` also removes history entries
  older than its cutoff.

## Fork and replay

`AgentExecutor.fork()` starts a new session from a step of another session's
history: "what if the tool had returned something else at step 1?" It takes the
newest history entry of `fromStep`, applies `patch`, saves the result as the
`'in-progress'` checkpoint of the new session and returns
`{ sessionId, step, checkpoint }`. Resume the fork like any unfinished run:

```ts
import { AgentExecutor, compareTrajectories, memoryStore } from '@loushy/build-ai-agent';

const { checkpoints } = memoryStore();
await AgentExecutor.execute({ agent, provider, toolRegistry, input: 'Plan my trip', sessionId: 'trip', checkpointStore: checkpoints });

const fork = await AgentExecutor.fork({
  sessionId: 'trip',
  fromStep: 1,
  checkpointStore: checkpoints,
  patch: { toolResult: { toolCallId: 'call_weather', result: { forecast: 'rain' } } },
});
// fork.sessionId is 'trip.fork-1'; the 'trip' checkpoint and history are unchanged.
await AgentExecutor.execute({ agent, provider, toolRegistry, input: [], sessionId: fork.sessionId, checkpointStore: checkpoints });

const original = await checkpoints.load('trip');
const replayed = await checkpoints.load(fork.sessionId);
if (original && replayed) {
  const { divergedAt, a, b, drift } = compareTrajectories(original, replayed);
  console.log(divergedAt, a.length, b.length, drift); // 1, then each run's steps and the tool-call diff
}
```

With `createAgent({ store })`, `agent.fork(sessionId, { fromStep, patch? })`
does the same over `store.checkpoints`, and `agent.resume(fork.sessionId)`
continues the fork:

```ts
import { createAgent, memoryStore } from '@loushy/build-ai-agent';

const assistant = createAgent({ provider, store: memoryStore() });
await assistant.send('Plan my trip', { sessionId: 'trip' });
const fork = await assistant.fork('trip', { fromStep: 1, patch: { appendInput: 'It will rain, plan for that.' } });
const result = await assistant.resume(fork.sessionId);
```

- `patch` is applied in this order: `messages(messages)` rewrites the
  transcript; `businessState` replaces it; `toolResult: { toolCallId, result }`
  replaces that call's result in place (same position, call id and tool name,
  so the transcript stays valid for every provider), or records it when the
  call has no result yet; `appendInput` queues a user message, which is sent
  after any tool calls still pending.
- The fork keeps the source checkpoint's step count and usage, so the rest of
  the `maxSteps` budget applies to it. Recorded tool results are not re-run;
  tool calls without a result run first, as on any resume (so a fork of an
  `'awaiting-approval'` entry goes through `needsApproval` again; the old
  `approvalId` is not carried over).
- `newSessionId` names the fork; the default is `<sessionId>.fork-<n>`, the
  first `n` with no checkpoint. A `newSessionId` that already has a checkpoint
  is refused.
- A step the history does not have (the session is unknown, the step never
  ran, or it was dropped past `historyLimit`) throws an `SDKError` with code
  [`LOUSHY_CHECKPOINT_NOT_FOUND`](./errors.md#loushy_checkpoint_not_found),
  whose message lists the steps that are kept. A store without `history()`
  cannot fork (`ConfigurationError`).
- `compareTrajectories(a, b)` takes two checkpoints or two transcripts and
  returns each run's steps (one per assistant turn: its text and tool calls
  with their results), `divergedAt` (the first step that differs, tool call
  ids aside) and `drift`, the tool-order, argument, step-count and
  finish-reason differences in the same shape as `loushy eval --drift`.

## Compatibility with stored data

- Checkpoints written before `status` existed are treated as
  `'in-progress'` (before this change, finished runs deleted their
  checkpoint, so only unfinished runs were ever stored).
- Sessions saved before a store kept a history have an empty history until
  their next save.
- Approval snapshots written before `remainingToolCalls` existed resume as
  they used to: the calls after the paused one do not run. Each of them gets
  an error result saying it was not run, so the transcript stays valid.

## Limits

- A `sessionId` identifies one logical conversation; running two
  `execute()` calls on the same id at the same time is not supported.
- If you call `resumeAfterApproval()` without the `checkpointStore`, the
  session keeps its `'awaiting-approval'` mark and later `execute()` calls
  keep throwing `SessionAwaitingApprovalError`; pass the store (or delete
  the checkpoint).
- Workers KV is eventually consistent across locations - see
  [Deployment](./deployment.md) for the caveat.
