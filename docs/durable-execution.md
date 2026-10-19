# Durable execution

Give `createAgent()` a `store` and pass a `sessionId` to `send()`, and the
run survives a crash, a restart, an abort or a human approval that takes
days. Nothing here depends on a particular host: any `CheckpointStore`
(`memoryStore()`, `SqliteStore`, the Cloudflare KV store the
`cloudflare-worker` build wires up, or your own three-method implementation)
and any `ApprovalStore` work the same way.

See also: [Pause, restart, resume](./pause-and-resume.md), a short end-to-end tutorial.

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const agent = createAgent({ provider, store: new SqliteStore('./.lousho/jobs.db') });

// First message of a conversation.
await agent.send('Book a table for 2 tonight', { sessionId: 'chat-42' });

// Later - same process or another one - the next message of the same conversation.
await agent.send('Make it 3 people', { sessionId: 'chat-42' });

// After a crash: finish the interrupted run, if there is one (`null` when nothing is pending).
const finished = await agent.resume('chat-42');
```

The `store` option does the wiring: `store.checkpoints` holds the run's
checkpoints and `store.approvals` holds approval pauses, and
`agent.approvals.resolve()` keeps checkpointing the run under its
`sessionId`. `stream()` takes a `sessionId` too. Sessions are checkpointed
too: `agent.session({ id })` checkpoints every turn and `agent.resume(id)` (or
`session.resume()`) finishes an interrupted one - see
[Durable sessions](./sessions.md#durable-sessions).

Underneath, `createAgent()` runs `AgentExecutor.execute()` with a
`sessionId` and a `checkpointStore`; the behavior described below is the
executor's, and the [advanced section](#advanced-the-executor-api) shows the
executor calls.

## What is checkpointed, and when

A checkpoint is the run's whole transcript plus its step count, usage,
`businessState` and a `status`. `send()` (and `stream()`) write it under the
`sessionId`:

| Moment | `status` |
| ------ | -------- |
| Right after each model response that asks for tools, before any tool runs | `'in-progress'` |
| Each time a tool result is recorded (results are recorded in call order) | `'in-progress'` |
| When the run is aborted (`signal`) | `'in-progress'` |
| When the run pauses for an approval (its own tool call's, or a [sub-agent](sub-agents.md)'s, also when a resumed sub-agent pauses again) | `'awaiting-approval'` (with `approvalId`) |
| When the run finishes (the model stopped calling tools, or `maxSteps` ran out) | `'finished'` |

A run that rejects (a provider error, a throwing hook, a
`PropagatingToolError`, a process crash) keeps its last `'in-progress'`
checkpoint. When it rejects (rather than crashes), the checkpoint also gets the
error as `lastError` and the count of failed attempts as `attempts`, so
[`agent.pending()`](#recovering-after-a-crash) can tell a run that
keeps failing from one a crash interrupted. The next checkpoint the run saves
(it made progress) drops both.

While a [sub-agent](sub-agents.md) runs, what it has spent so far is saved on
the lead's checkpoint after each of its model calls and tool results
(`delegatedInFlight`). A sub-agent is not checkpointed itself: when the lead
crashes mid-sub-agent and is resumed, the `task` call runs again and the
sub-agent starts over, but the model calls of the interrupted attempt stay in
the resumed run's `usage` (as one more delegated run).

## What happens when you send again with the same `sessionId`

Calling `send()` again with the same `sessionId` (or `execute()`, on the
executor) depends on the stored `status`:

- **Unfinished run** (`'in-progress'`: it crashed, was aborted, or a store
  write failed). The run resumes (`agent.resume(sessionId)` does the same
  without new input). If its last model turn has tool calls
  without a result, exactly those calls run first, through the normal tool
  path (argument validation, hooks, `needsApproval`, `toolConcurrency`),
  **without calling the model again**. Then the loop continues, with the
  remaining `maxSteps` budget; `usage` continues from the checkpointed
  totals (the same holds after `agent.approvals.resolve()`, from the snapshot).
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
- **Paused awaiting approval** (`'awaiting-approval'`). `send()` throws
  `SessionAwaitingApprovalError` (with `sessionId` and `approvalId`) and
  does not call the model or any tool: new input must not bypass a pending
  decision. Resolve it with `agent.approvals.resolve()` first, then send the
  new message.

System messages in `input` are ignored when it is added to a stored
session (the session already has its system prompt). To end a session and
start over under the same id, call `store.checkpoints.delete(sessionId)`.

```ts
import { createAgent, memoryStore, SessionAwaitingApprovalError } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: memoryStore() });

try {
  await agent.send('Are you done?', { sessionId: 'chat-42' });
} catch (error) {
  if (error instanceof SessionAwaitingApprovalError) {
    console.log(`Waiting on approval ${error.approvalId} - resolve it with agent.approvals.resolve() first.`);
  }
}
```

## Approvals in the middle of a tool batch

When one model turn asks for several tools and some of them need approval,
the calls that need none run and are recorded, and the run pauses once on
every call that needs approval (`approvalIds`, one approval record each; see
[Several calls in one step](./approvals.md#several-calls-in-one-step)).
Calls a steer kept from starting, and the turn's handoff calls, are recorded
in the approval snapshot (`remainingToolCalls`). Once the last paused call is
decided, `agent.approvals.resolve()` (the `resumeAfterApproval()` export
underneath):

1. records each paused call's result, in call order - the tool's result if
   approved, or a structured `{ error, note }` rejection result if rejected;
2. runs the remaining calls through the same batch logic: they can run,
   fail validation, or pause the run again on another approval (a new
   `approvalId`; resolve it the same way, as many times as needed);
3. calls the model once every call of the turn has exactly one result.

```ts
import { createAgent, memoryStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: memoryStore() });

const paused = await agent.send('Email the whole team', { sessionId: 'chat-42' });

if (paused.finishReason === 'awaiting-approval') {
  // ...a human decides, possibly days later, in another process (same store)...
  const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
  console.log(result.finishReason); // 'stop', or 'awaiting-approval' again for the next gated call
}
```

The resumed run uses the same `approvalStore` for any later approval unless
you pass a different one in the options.

## Recovering after a crash

A run that was interrupted (the process crashed or was killed mid-turn) or
that is paused on an approval stays in `store.checkpoints` until someone
finishes it. `agent.pending()` lists those runs across every session and
`send(msg, { sessionId })` id, so a restarted process can find them:

```ts
import { createAgent, fileStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: fileStore('./.lousho') });

// At startup, before taking traffic:
for (const run of await agent.pending()) {
  if (run.status === 'in-progress') {
    // Finishes the turn without re-running recorded steps (tools that were mid-call run again: make them idempotent).
    await agent.resume(run.sessionId);
  } else {
    // 'awaiting-approval': hand run.approvalId to a human, or decide it here.
    console.log(`session ${run.sessionId} waits on approval ${run.approvalId}`);
  }
}
```

`agent.resume()` resolves with the finished `ExecutionResult` (or `null` when
nothing was pending); it does not return a stream. To watch a resumed run's
events, stream it instead: `agent.stream([], { sessionId })` resumes an
unfinished `kind: 'run'` checkpoint without new input (see
[above](#what-happens-when-you-send-again-with-the-same-sessionid)) and
returns the usual `AgentRun`. A paused run streams with
`agent.approvals.streamResolve()`.

`pending()` reads the shared checkpoint store, so it also lists runs that
are still running right now in another process or replica (as
`'in-progress'`, without `lastError`) - not only crashed ones. See below for
why resuming one of those is safe.

Each entry is `{ sessionId, kind, checkpointId, status, approvalId?,
approvalKind?, step, lastError?, attempts? }`:

- `sessionId` is what `agent.resume()` takes: the `agent.session()` id for a
  session turn (`kind: 'session'`, checkpointed as `<id>.turn-<n>`), or the
  `send(msg, { sessionId })` id (`kind: 'run'`, also forks).
- `status` is `'in-progress'` (interrupted) or `'awaiting-approval'` (decide
  `approvalId` with `agent.approvals.resolve()`; `agent.approvals.list()`
  shows the call).
- `lastError` is set when the last attempt at a session turn, or at a
  `send(msg, { sessionId })` run (`kind: 'run'`), failed; `attempts` counts
  the attempts that failed in a row. With `retryable: false` (a 400 from the
  provider, for example) it will fail again: fix the cause before
  `agent.resume()`, or drop it with `agent.session({ id }).discardPending()`
  (a run: `store.checkpoints.delete(id)`). An `'in-progress'` entry without
  `lastError` was interrupted (a crash), or is still running.

A run that is still running in some process is listed as `'in-progress'`
too. Resuming it is safe: the run holds a lease (see [Run leases](#run-leases)),
so `agent.resume()` fails with `LOUSHO_SESSION_BUSY` before anything runs
instead of running its tool calls a second time.

A checkpoint that cannot be read (a write cut short by a power loss on a store
without durable writes) is listed as `'in-progress'` with `lastError.code`
`LOUSHO_CHECKPOINT_CORRUPT` (`retryable: false`), the error `send()` and
`resume()` fail with; drop it with `discardPending()` (or `clear()`), or
`store.checkpoints.delete(id)` for a run.

### Recovering automatically

`agent.recover()` runs that recipe for you, in the background: every
`intervalMs` (default 30 seconds) it lists `agent.pending()` and calls
`agent.resume()` on each `'in-progress'` run. Start it once per process, next
to the code that serves traffic:

```ts
import { createAgent, defineTool, memoryStore, PropagatingToolError } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

let charges = 0;
let attempts = 0;
const tools = [
  defineTool({ name: 'charge', description: 'Charge the card', input: z.object({}), execute: async () => `charged ${++charges}` }),
  // Stands in for the process dying mid-step: it fails the first time only.
  defineTool({
    name: 'ship',
    description: 'Ship the order',
    input: z.object({}),
    execute: async () => {
      if (++attempts === 1) throw new PropagatingToolError('process died');
      return 'shipped';
    },
  }),
];
const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'charge' }] }, { toolCalls: [{ name: 'ship' }] }, 'Order charged and shipped.']),
  tools,
  store: memoryStore(),
});
await agent.send('Charge and ship order 7', { sessionId: 'order-7' }).catch(() => undefined); // interrupted after the charge

const recovery = agent.recover({
  intervalMs: 1_000,
  onRecovered: (run, result) => {
    console.log(`${run.sessionId}: ${result.text}`); // order-7: Order charged and shipped.
    void recovery.stop(); // a server keeps it running and stops it on shutdown (or passes `signal`)
  },
  onError: (error, run) => console.error('recovery failed', run?.sessionId, error),
});
await recovery.done; // resolves once the loop stopped
console.log(charges); // 1: the completed charge step did not run again
```

What a sweep does with each pending run:

- `'in-progress'`: resumed, from its last checkpoint, so completed steps never
  run again (a tool that was mid-call runs again: make it idempotent).
- `'awaiting-approval'` (a tool approval or an `ask_question`): left alone; a
  human decides it with `agent.approvals.resolve()`.
- A run whose `lastError` has `retryable: false`: left alone, since it would
  fail the same way; `agent.pending()` still lists it.
- A run still running in another process, or one whose crashed process's
  [run lease](#run-leases) has not expired yet: its resume is turned away
  with `LOUSHO_SESSION_BUSY` before anything runs, silently, and a later sweep
  tries again once the lease is free. So a crashed run is finished at most
  one lease expiry plus one `intervalMs` after the crash, and every replica
  can run `recover()`: the leases make sure only one of them resumes a run.
  The loop also never starts a second resume of a run it is already resuming.

`onError(error, run?)` hears about a sweep that could not list the store
(`run` undefined) and a resume that failed (`run` set); the loop keeps going
either way. `onRecovered(run, result)` gets each run it finished. Aborting
`signal` (or `stop()`) stops the polling and aborts the resumes in flight
(their checkpoints stay for the next start); `done` resolves once everything
settled. The loop keeps the process alive until it is stopped. Like
`pending()`, `recover()` throws `LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE`
without a checkpoint store. With a custom store that has no leases
(`acquireLease`), nothing stops it from resuming a run another process is
still running: run it in one process only.

## Run leases

While a checkpointed run executes (a session turn, a `send(msg, { sessionId })`
run, an approval resume), it holds a lease on its checkpoint id in the
checkpoint store: an owner id and an expiry 30 seconds out, renewed every 10
seconds. A second process, replica or store object that tries to run or resume
the same id meanwhile - a `send()` that would resume the pending turn first,
`agent.resume()`, `agent.approvals.resolve()` - fails with `LOUSHO_SESSION_BUSY`
before any tool runs or any model is called (a resolved approval stays
pending). Two replicas behind a load balancer therefore never run one turn's
tool calls twice.

A lease whose holder died is taken over once it expires. Expiry is judged by
the clock of the process that wants the lease against the expiry the holder
wrote with its own clock, so the file and SQLite stores wait one more lease
period (30 seconds) past it: a run left by a crashed process on another
machine is taken over 30 to 60 seconds after its last heartbeat, and replicas
whose clocks disagree by less than about 50 seconds never take over each
other's live runs. Keep replica clocks in sync (NTP); a larger skew can let
two replicas run one turn.

The file and SQLite stores take a lease over at once, without waiting, only
when its holder is provably gone:

- a run of the same process (the same thread and SDK instance) that no longer
  runs, so the usual "restart and resume" path does not wait;
- on Linux, a process that has exited, on the same host, the same boot and the
  same PID namespace (the lease records the boot id, the PID namespace and the
  process start time, so a reused process id does not count as alive or dead
  by mistake);
- on macOS and Windows, a process id of the same host that no longer exists.

A run of another worker thread of the same process, or of another container
with the same hostname on a shared volume (or a process restarted in a new
container), is never taken over early: it waits for the expiry.

The run's lease owner id is a fencing token. The heartbeat renews the lease
only while the run still holds it (it never takes back a lease another process
took, or one released after another process finished the run), and every
checkpoint the run saves is written only if the run still holds the lease,
atomically with that check in the file, SQLite and in-memory stores. So if a
run stalls for longer than its lease (the process was paused, or the event loop
blocked) and another process takes over, the stalled run stops with
`LOUSHO_SESSION_BUSY` at its next checkpoint instead of overwriting the new
holder's progress, and a session turn's late result is not added to the
transcript. A tool call the stalled run was already making when it lost the
lease is not undone: keep tools idempotent where a stall is possible.

The file, SQLite and in-memory stores take leases atomically. KV has no
compare-and-swap: `KVStore` writes the lease, waits 50 ms and reads it back,
which serializes requests at one location but not across edge locations within
KV's propagation delay; its fenced saves are a read then a write. A custom
`CheckpointStore` takes part by implementing `acquireLease(id, owner, ttlMs)`
(an atomic "take or renew unless another owner holds an unexpired lease",
resolving `true` when taken) and `releaseLease(id, owner)`; without them runs
execute without leases. It can add `renewLease(id, owner, ttlMs)` (renew only
the owner's own lease) and `saveIfLeased(id, checkpoint, owner)` (save only
while the owner holds the lease, atomically); without them a run renews its
lease with `acquireLease` right before each save, which leaves a short window.

During a rolling upgrade from a release without run leases, the old replicas
neither take nor respect leases, so a turn can still run on an old and a new
replica at once until every replica runs the new release. A SQLite database
opened by this release is migrated (the `leases` table) and is then refused by
older releases; roll back by restoring a copy of the file.

Schedules use the same mechanism: `fireSchedule()` (and so `startSchedules()`)
claims each schedule's fire time in the agent's checkpoint store first, so
replicas that fire the same tick run it once.

`agent.pending()` needs a checkpoint store with `list()`: the file, SQLite,
in-memory and KV stores have one (`KVStore` lists only when its namespace
binding has `list`, as a real one does). On a custom `CheckpointStore`,
`list({ status? })` returns `{ sessionId, status, checkpoint }` for the
latest checkpoint of every id; `listCheckpoints(entries, options)` does the
filtering and ordering for you. Without it `agent.pending()` throws
`LOUSHO_CONFIG_INVALID`; without a checkpoint store at all, it throws
`LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE`.

## Guarantees

- **Every tool call gets exactly one result, in call order**, after any
  sequence of crashes, aborts, pauses and resumes. (An aborted call gets a
  "cancelled" result; a rejected call gets a rejection result.)
- **A recorded result is never re-executed.** Each result is checkpointed
  by its `toolCallId` as soon as its call settles - even one that finished
  behind a slower earlier call of the same turn - so a resumed run only
  runs calls that have no recorded result.
- **A checkpointed model turn is never generated again.** If the process
  dies after the model answered, the resumed run executes that answer's tool
  calls instead of asking the model again (no extra cost, no different
  plan).
- **The provider always receives a valid transcript**: tool results
  directly follow their tool-call turn, and new user input comes after them.
- **An approved call runs at most once.** Deciding an approval keeps the
  paused run's checkpoint: it is re-saved as `'in-progress'` with the approved
  call marked as started (`startedToolCallIds`) before the call runs, and
  saved again with its result before the run continues. If the process dies
  while the approved call runs, the turn is not lost: `pending()` lists it,
  and resuming it does not run the call again. The call gets an error result
  (`kind: 'interrupted'`) telling the model it may or may not have taken
  effect, so the model can check or ask instead of silently repeating it - a
  human approved it once, not twice.
- **A stale approval never comes back.** An approval continues its run only
  while that run's checkpoint still waits on it. Once the checkpoint was
  deleted (`checkpoints.delete(id)`, `discardPending()`, a prune) or replaced
  by a newer run under the same id, resolving it fails with
  `LOUSHO_APPROVAL_ORPHANED` and withdraws it, without running the tool or
  touching the newer run. `discardPending()` withdraws the dropped turn's
  approvals at once.

## Run a job once (webhook redelivery)

A webhook or queue delivers at least once, so the same payload can arrive
twice. Sending it again with the same `sessionId` is **not** a no-op: once
the first run is `'finished'`, the second `send()` is a new turn of that
conversation and calls the model again (in a consumer test it re-ran seven
model calls). To run a job once, derive the `sessionId` from the delivery id
and look at the checkpoint before sending:

```ts
import { createAgent, memoryStore } from '@lousho/build-ai-agent';

const store = memoryStore();
const agent = createAgent({ provider, store });

export async function handleDelivery(deliveryId: string, payload: string) {
  const sessionId = `job-${deliveryId}`;
  const checkpoint = await store.checkpoints?.load(sessionId);

  if (checkpoint?.status === 'finished') return; // already done: acknowledge the redelivery
  if (checkpoint?.status === 'awaiting-approval') return; // paused: resolve it with agent.approvals.resolve()
  if (checkpoint) {
    await agent.resume(sessionId); // 'in-progress': a crash left it half done; finish it
    return;
  }
  await agent.send(payload, { sessionId });
}
```

The check-then-send is not atomic: two concurrent deliveries can both see no
checkpoint. Serialise deliveries per id (a queue keyed by `deliveryId`, or a
unique-insert in your own database) and keep the run lease on (see
[Run leases](#run-leases)) so a second process fails with
`LOUSHO_SESSION_BUSY` instead of running the job twice. Tools that run again
on resume must still be idempotent, so also pass the call's `toolCallId` as
the idempotency key of every side effect (see the next section).

## At-least-once tools: make side effects idempotent

A tool that was **running** when the process died has no recorded result,
so it runs again on resume. Tool execution is therefore at-least-once, not
exactly-once. For tools with side effects (charging a card, sending an
email), either gate them with `needsApproval` or make them idempotent.
Each call's `toolCallId` (the model's id for the call, unchanged when that
same call is re-run on resume) is passed to `execute`, so it works as an
idempotency key against a re-run of one call:

```ts
import { defineTool } from '@lousho/build-ai-agent';
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

(`toolCallId` is set for every tool run, including tools that route through
`sandboxExecute`.)

The built-in file tools are safe to re-run. `write_file` writes the same
content again; an `edit_file` whose edit is already in the file (`old_string`
gone, a non-empty `new_string` present) succeeds and says the edit was already
applied, instead of telling the model that an applied edit failed. With
`WorkspaceCheckpoints`, each change's backup is stored before the file is
written and a re-run keeps the first backup, so `rewind()` restores the
original content after a crash too (see
[Workspace tools](./workspace-tools.md#the-tools)). The `shell` tool is not:
a command that was running when the process died runs again.

`toolCallId` (and `ctx.approval.id` for an approved call) identifies one call
the model made. It only protects against that call running twice. If the
process dies before the call is recorded, the model may make the call again
as a **new** call with a new id and a new approval, and the id no longer
matches. A side effect that must happen once per business event (one claim,
one invoice) needs an idempotency key from your own data, such as the claim id
in the arguments, checked or passed on to the system you write to:

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

declare const claims: { file(claim: { claimId: string }, opts: { idempotencyKey: string }): Promise<{ id: string }> };

const fileClaim = defineTool({
  name: 'file_claim',
  description: 'File an insurance claim',
  input: z.object({ claimId: z.string() }),
  needsApproval: true,
  execute: async ({ claimId }) => claims.file({ claimId }, { idempotencyKey: `claim:${claimId}` }), // a new call for the same claim cannot file twice
});
```

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
| `fileStore(dir)` (JSON files) | yes (`checkpoint-history/<id>.json`) | `fileStore(dir, { historyLimit })` |
| `KVCheckpointStore` / `KVStore` (Cloudflare Workers KV, from `@lousho/build-ai-agent/kv`) | yes (see below) | `new KVStore(kv, { historyLimit })` |
| Agent Forge's `FileCheckpointStore` | yes | `new FileCheckpointStore(dir, { historyLimit })` |
| a custom `CheckpointStore` | only if it implements `history()` | - |

For example, with the in-memory store:

```ts
import { getCheckpointHistory, memoryStore } from '@lousho/build-ai-agent';

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
  (`.lousho/agents/<id>/checkpoint-history/<session>.json`, replaced
  atomically); a file damaged by a crash reads as no history and is rebuilt by
  the next save.
- `SqliteStore` keeps the history in a new `checkpoint_history` table, added when
  an existing database file is opened; `prune()` also removes history entries
  older than its cutoff.

## Fork and replay

`agent.fork(sessionId, { fromStep, patch? })` starts a new session from a step
of another session's history: "what if the tool had returned something else
at step 1?" It takes the newest history entry of `fromStep`, applies `patch`,
saves the result as the `'in-progress'` checkpoint of the new session over
`store.checkpoints` and returns `{ sessionId, step, checkpoint }`. Resume the
fork like any unfinished run with `agent.resume(fork.sessionId)`:

```ts
import { createAgent, compareTrajectories, memoryStore } from '@lousho/build-ai-agent';

const store = memoryStore();
const assistant = createAgent({ provider, store });
await assistant.send('Plan my trip', { sessionId: 'trip' });

const fork = await assistant.fork('trip', { fromStep: 1, patch: { appendInput: 'It will rain, plan for that.' } });
// fork.sessionId is 'trip.fork-1'; the 'trip' checkpoint and history are unchanged.
const result = await assistant.resume(fork.sessionId);

const original = await store.checkpoints?.load('trip');
const replayed = await store.checkpoints?.load(fork.sessionId);
if (original && replayed) {
  const { divergedAt, a, b, drift } = compareTrajectories(original, replayed);
  console.log(divergedAt, a.length, b.length, drift); // 2, then each run's steps and the tool-call diff
}
```

`AgentExecutor.fork()` is the same operation on the executor; see the
[advanced section](#advanced-the-executor-api).

`agent.fork()` forks one run by its checkpoint history. To branch a
multi-turn `agent.session()` conversation, use `session.history()` and
`session.fork({ fromStep })`, which work from the session's saved transcript
with any store (finished turns keep no checkpoint history); see
[Forking a session](./sessions.md#forking-a-session).

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
  [`LOUSHO_CHECKPOINT_NOT_FOUND`](./errors.md#lousho_checkpoint_not_found),
  whose message lists the steps that are kept. A store without `history()`
  cannot fork (`ConfigurationError`).
- `compareTrajectories(a, b)` takes two checkpoints or two transcripts and
  returns each run's steps (one per assistant turn: its text and tool calls
  with their results), `divergedAt` (the first step that differs, tool call
  ids aside) and `drift`, the tool-order, argument, step-count and
  finish-reason differences in the same shape as `lousho eval --drift`.

## Resuming with a changed agent

Every checkpoint and approval snapshot carries an **agent fingerprint**: the
model id, each tool's name with a hash of its JSON input schema, and a hash of
the system instructions (plus a short SHA-256 over all of them, computed with
Web Crypto). Functions and other values that cannot be serialized (a tool's
`execute`, hooks, callbacks) are not part of it, so changing only code never
counts as a change. The parts are stored one by one so a mismatch can say what
changed.

When a run is resumed (`agent.resume(id)`, `session.resume()`, a later
`execute()` on an unfinished `sessionId`, `agent.approvals.resolve()` and the
streamed forms), the resuming agent's fingerprint is compared with the saved
one, before any model call or tool runs. `onAgentDrift` on `createAgent()` (and
on `AgentExecutor.execute()` / the `resumeAfterApproval()` export) decides what a
difference does:

| `onAgentDrift` | On a different model, tools or instructions |
| -------------- | ------------------------------------------- |
| `'warn'` (default) | A `console.warn` naming what changed and an `agent.drift` event (`model`, `toolsAdded`, `toolsRemoved`, `toolsChanged`, `instructions`); the run continues. |
| `'error'` | Rejects with [`LOUSHO_AGENT_DRIFT`](./errors.md#lousho_agent_drift). The checkpoint is left as it was; an approval is put back, so the right agent can still resolve it. |
| `'ignore'` | Nothing. |

A pending tool call whose tool no longer exists (the model's last turn called
it and it has no result yet, or the human approved it) always rejects with
[`LOUSHO_RESUME_TOOL_MISSING`](./errors.md#lousho_resume_tool_missing),
whatever the option.

```ts
import { createAgent, memoryStore } from '@lousho/build-ai-agent';
import type { LLMProvider } from '@lousho/build-ai-agent';

declare const provider: LLMProvider;

// After a deploy that renamed a tool or changed the model, refuse to continue old runs.
const agent = createAgent({ provider, store: memoryStore(), onAgentDrift: 'error' });
const result = await agent.resume('job-1');
```

Notes:

- Checkpoints and snapshots written before this existed have no fingerprint
  and resume exactly as before, with no warning.
- A run of a [dynamic agent](./api-overview.md#dynamic-config) saves the `ctx`
  and the model it chose in the checkpoint (`runConfig`), and a crash resume
  uses them: the saved model, and tools and instructions resolved again with
  the saved `ctx` (before, it resolved with `input: []` and no `metadata`).
- The fingerprint covers the agent's own tools, model and instructions, not
  the tools that `subagents` and `skills` add. A sub-agent that pauses for an
  approval has its own fingerprint in its nested snapshot. On resume, each
  paused level (the lead, the sub-agent, and a sub-agent of that sub-agent) is
  compared with its current definition from `subagents`, under the lead's
  `onAgentDrift`. With `'warn'` the `agent.drift` event carries `subagent`.
  When a sub-agent's check rejects, the lead's approval and its
  `'awaiting-approval'` checkpoint are put back, so fixing the sub-agent and
  resolving again works. A [remote sub-agent](./sub-agents.md#remote-sub-agents)
  is not compared: its pause is kept on the remote.
- A run resumed after an approval continues with the instructions it started
  with (they are in its transcript), so its later checkpoints record those.

## Advanced: the executor API

`createAgent()` is built on `AgentExecutor`, which stays available when you
want to own the wiring: the provider, the `ToolRegistry`, the stores and the
resume calls are all explicit (see [The executor API](./executor-api.md)). Each snippet below says which `createAgent()`
call it corresponds to.

`AgentExecutor.execute()` with a `sessionId` and a `checkpointStore` is
`agent.send(message, { sessionId })`:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { LocalStorageCheckpointStore } from '@lousho/build-ai-agent/utils';

const checkpoints = new LocalStorageCheckpointStore(storage);

// First message of a conversation.
await AgentExecutor.execute({ agent, input: 'Book a table for 2 tonight', provider, sessionId: 'chat-42', checkpointStore: checkpoints });

// Later - same process or another one - the next message of the same conversation.
await AgentExecutor.execute({ agent, input: 'Make it 3 people', provider, sessionId: 'chat-42', checkpointStore: checkpoints });
```

It throws `SessionAwaitingApprovalError` on a paused session, as `send()` does:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { SessionAwaitingApprovalError, memoryStore } from '@lousho/build-ai-agent';

const { checkpoints } = memoryStore();

try {
  await AgentExecutor.execute({ agent, input: 'Are you done?', provider, sessionId: 'chat-42', checkpointStore: checkpoints });
} catch (error) {
  if (error instanceof SessionAwaitingApprovalError) {
    console.log(`Waiting on approval ${error.approvalId} - resolve it with resumeAfterApproval() first.`);
  }
}
```

The exported `resumeAfterApproval()` function is what
`agent.approvals.resolve()` calls:

```ts
import { AgentExecutor, resumeAfterApproval } from '@lousho/build-ai-agent/executor';

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

`AgentExecutor.fork()` is `agent.fork()`; `execute()` with `input: []` on the
fork's `sessionId` is `agent.resume(fork.sessionId)`:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { compareTrajectories, memoryStore } from '@lousho/build-ai-agent';

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

- A `sessionId` identifies one logical conversation. Concurrent
  `agent.send()` / `agent.stream()` calls with the same `sessionId` on one
  agent store run one after another, in call order, in this process. Two
  processes (or two store objects over the same data) on the same id at the
  same time are refused with `LOUSHO_SESSION_BUSY` by the run lease (best
  effort on KV, see [Run leases](#run-leases)); with a custom store that has no
  leases, the last save wins.
- A run id (`sessionId` of `send()` / `stream()`) is 1-200 characters of
  letters, digits, `_`, `-` and `.`, not starting or ending with `.`, on every
  store, and may not end with `.turn-<n>` or `.paused` (a session's own
  checkpoint keys) or `.fire` (a schedule's fire claim). Anything else fails
  with `LOUSHO_SESSION_ID_INVALID`. A session id (`agent.session({ id })`, the
  routes' `sessionId`) has a stricter rule: 1-128 characters of
  `A-Za-z0-9_-`, with no `.`.
- If you call `resumeAfterApproval()` (the function behind
  `agent.approvals.resolve()`) without the `checkpointStore`, the session
  keeps its `'awaiting-approval'` mark and later `send()` (or `execute()`)
  calls keep throwing `SessionAwaitingApprovalError`; pass the store (or
  delete the checkpoint). `agent.approvals.resolve()` passes it for you.
- Workers KV is eventually consistent across locations - see
  [Deployment](./deployment.md) for the caveat.
- The spend of a sub-agent still running when its lead crashed is kept for
  in-process sub-agents only, as of its last model call or tool result: a
  [remote sub-agent](./sub-agents.md#remote-sub-agents) reports its usage
  when it ends, so an interrupted one's calls are not counted, and a
  background sub-agent still running after the lead paused or finished does
  not write the lead's checkpoint. Their limits are checked against a
  sub-agent's usage only once it returns.
