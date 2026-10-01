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

## Compatibility with stored data

- Checkpoints written before `status` existed are treated as
  `'in-progress'` (before this change, finished runs deleted their
  checkpoint, so only unfinished runs were ever stored).
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
