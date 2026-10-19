# Pause, restart, resume

A tutorial for one job: an agent that stops to ask a human before a risky tool
call, survives a process restart while it waits, and carries on once someone
decides. Then what happens when the process dies in the middle of a tool.

The snippets use `mockModel` so they run as pasted, with no API key. Swap in a
real `provider` or `model` for your own agent; nothing else changes. Each
section links to the page that has the full detail.

## 1. A tool that needs approval

Set `needsApproval` on the tool. The run pauses before the tool executes:

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

export const refund = defineTool({
  name: 'refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  needsApproval: true, // or a predicate over the arguments
  execute: async ({ orderId }) => `refunded ${orderId}`,
});
```

See [Approvals](./approvals.md#which-calls-pause) for predicates and permission
policies.

## 2. Give the agent a durable store

Pauses and checkpoints live in the agent's `store`. The default is in memory,
which a restart loses. Use a durable one: `SqliteStore` (one transactional file,
shared safely by several processes) or `fileStore(dir)` (plain JSON files). See
[Choosing a store](./sessions.md#choosing-a-store).

## 3. Send: the run pauses

`send()` does not throw at a pause. It resolves with
`finishReason: 'awaiting-approval'` and the id to decide:

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const refund = defineTool({
  name: 'refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  needsApproval: true,
  execute: async ({ orderId }) => `refunded ${orderId}`,
});

const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'refund', args: { orderId: 'B-1' } }] }]),
  tools: [refund],
  store: new SqliteStore('./pause-and-resume.db'),
});

// `sessionId` makes the run durable: its progress is checkpointed under this id.
const paused = await agent.send('Refund order B-1', { sessionId: 'refund-B-1' });
console.log(paused.finishReason, paused.approvalId); // 'awaiting-approval', '...'
// The process can exit now. The pause is in the store.
```

Use `agent.session({ id })` instead of `sessionId` when the conversation should
keep a transcript across turns (see [Sessions](./sessions.md#durable-sessions));
the pause and resume calls below are the same.

## 4. In a new process: list the pauses and decide one

Start the process again with the same store. `agent.approvals.list()` returns
the pending calls, oldest first, including the ones another process or an earlier
run left in the store. `agent.approvals.resolve()` runs the call (or rejects it),
continues the run, and resolves with the result:

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const refund = defineTool({
  name: 'refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  needsApproval: true,
  execute: async ({ orderId }) => `refunded ${orderId}`,
});

// The same agent definition and the same store. Here the mock model only has
// the final reply left to give; a real provider needs no script.
const agent = createAgent({
  provider: mockModel(['Order B-1 is refunded.']),
  tools: [refund],
  store: new SqliteStore('./pause-and-resume.db'),
});

for (const call of await agent.approvals.list()) {
  console.log(`${call.toolName}`, call.args); // refund { orderId: 'B-1' }
  const result = await agent.approvals.resolve({ id: call.id, approved: true });
  console.log(result.finishReason, result.text); // 'stop', 'Order B-1 is refunded.'
}
```

- To reject, pass `approved: false` and a `note` the model sees as the reason.
- A session that paused is found from its pause record, so you do not need to
  open it or call `resume()` first.
- `resolve()` throws when the id is unknown or already decided, so two processes
  racing on one pause cannot both run the tool.
- A pause from `send(msg, { sessionId })` shows in `agent.pending()` with
  `status: 'awaiting-approval'` and its `approvalId`.

## 5. See the run finish

`resolve()` resolves with the continued run's result. The tool ran, the model got
its output and answered, and `finishReason` is `'stop'`. If the continued run
pauses again (another `needsApproval` call), you get `'awaiting-approval'` and a
new id: list and decide again. To show progress to a user instead, use
`agent.approvals.streamResolve()`. Everything else about decisions (several calls
in one step, "don't ask again", approve with edited arguments, expiry) is in
[Approvals](./approvals.md#createagent-agents).

## 6. When the process dies mid-run

A crash or a kill leaves the run's checkpoint in the store with status
`'in-progress'`. A restarted process finds it with `agent.pending()` and finishes
it with `agent.resume(sessionId)`, or hands the whole job to `agent.recover()`.

This snippet stands in for the crash with a tool that throws
`PropagatingToolError` the first time (the way a dying process would stop the
step), then recovers:

```ts
import { createAgent, defineTool, memoryStore, PropagatingToolError } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

let charges = 0;
let attempts = 0;
const tools = [
  defineTool({ name: 'charge', description: 'Charge the card', input: z.object({}), execute: async () => `charged ${++charges}` }),
  defineTool({
    name: 'ship',
    description: 'Ship the order',
    input: z.object({}),
    execute: async () => {
      if (++attempts === 1) throw new PropagatingToolError('process died'); // the "crash"
      return 'shipped';
    },
  }),
];
// Use fileStore(dir) or a SqliteStore in real code: memoryStore() does not survive a restart.
const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'charge' }] }, { toolCalls: [{ name: 'ship' }] }, 'Order charged and shipped.']),
  tools,
  store: memoryStore(),
});
await agent.send('Charge and ship order 7', { sessionId: 'order-7' }).catch(() => undefined);

// After the restart: what is unfinished?
for (const run of await agent.pending()) {
  console.log(run.sessionId, run.status); // order-7 in-progress
}

// Finish it. Completed steps are not run again.
const finished = await agent.resume('order-7'); // ExecutionResult, or null when nothing was pending
console.log(finished?.text, charges); // Order charged and shipped. 1
```

To do this without writing the loop, start `agent.recover()` once per process at
startup: it polls `pending()` and resumes every `'in-progress'` run, leaves
approvals for a human, and is safe to run on every replica (run leases make sure
one process resumes each run). See
[Recovering automatically](./durable-execution.md#recovering-automatically).

**At-least-once for the step that was running.** Recorded model responses and
finished tool results are never repeated: that is why `charge` ran once above.
But a tool that was mid-call when the process died runs again on resume, so its
side effect can happen twice. Make such tools idempotent (an idempotency key
passed to the payment API, a "have I done this" check). See
[At-least-once tools](./durable-execution.md#at-least-once-tools-make-side-effects-idempotent).
A tool with `needsApproval` is not affected by this while it waits: a pause
records no work, it only waits for the decision.

## 7. Over HTTP

The built server (see [Deployment](./deployment.md)) does this for you. A client
that resends a `POST /chat` after a dropped connection can send the same
`Idempotency-Key` header: a finished turn is replayed without running anything,
and a turn interrupted by a crash is resumed from its last checkpoint instead of
starting over. A session paused on an approval answers `409`
(`LOUSHO_SESSION_AWAITING_APPROVAL`) until it is decided. The table of outcomes
is in [Resending a turn](./deployment.md#resending-a-turn).

## Where to go next

- [Approvals](./approvals.md): permission policies, several calls in one step,
  expiry, deciding in code.
- [Sessions](./sessions.md#durable-sessions): durable session turns and stores.
- [Durable execution](./durable-execution.md): checkpoints, run leases, the
  guarantees, fork and replay.
