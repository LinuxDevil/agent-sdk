# Approvals

Flag a tool `needsApproval` and the run pauses before calling it, until a human
(or your code) approves or rejects the call. The pause is saved in an
`ApprovalStore`, so the decision can come minutes or days later, from another
request or another process, and the run then continues where it stopped.

```ts
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});
const agent = createAgent({ provider, instructions: 'You send emails.', tools: [sendEmail] });

const paused = await agent.send('Email the report to sam@example.com');
if (paused.finishReason === 'awaiting-approval') {
  console.log(await agent.approvals.list()); // [{ id, toolName: 'send_email', args: { to: '...' }, ... }]
  const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true }); // or approved: false, note: 'why'
  console.log(result.text);
}
```

## Which calls pause

`needsApproval` is `true`, or a predicate that receives the validated
arguments, typed from the tool's zod `input`:

```ts
import { defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // only external recipients pause
  async execute({ to, subject, body }) {
    return { messageId: '...' };
  },
});
```

When the model asks for several tools in one turn, the first call that needs
approval stops the batch: the calls before it run, the run pauses on it, and
the calls after it run once it is decided (see
[Approvals in the middle of a tool batch](./durable-execution.md#approvals-in-the-middle-of-a-tool-batch)).

## `createAgent()` agents

- A paused `send()` resolves (it does not throw) with
  `finishReason: 'awaiting-approval'` and an `approvalId`.
- `agent.approvals.list()` returns the pending calls this agent paused on in
  this process, oldest first: `{ id, toolCallId, toolName, args, createdAt }`,
  plus `subagentPath` when the call belongs to a sub-agent.
- `agent.approvals.resolve({ id, approved, note? })` runs the call (approved)
  or gives the model a rejection with your `note` (rejected), continues the
  run, and resolves with the continued run's result, which may pause again.
  It throws when `id` is unknown or already resolved.
- A run that paused inside `agent.session()` continues in that session: the
  tool call, its result and the final answer join the session's transcript.
- `agent.stream()` and `session.stream()` end at the pause with an
  `approval.requested` event and `run.done` (`'awaiting-approval'`); resolve it
  the same way.

Pauses are kept in a per-agent `InMemoryApprovalStore` unless you pass
`approvalStore` or a `store` with `approvals`. To decide a pause after a
restart, give the agent a durable store, such as the SQLite one (see
[Choosing a store](./sessions.md#choosing-a-store)):

```ts
import { createAgent } from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const store = new SqliteStore('./.loushy/agent.db');
const agent = createAgent({ provider, tools: [emailTool], store }); // or approvalStore: store.approvals
```

`list()` only knows the pauses made by this agent object; keep the
`approvalId` (or read the store) to resolve a pause from somewhere else. A
continued run joins a session only when it is resolved through the agent that
owns that session object.

### Deciding in code

Pass `approve` to decide each call as it comes up instead of pausing: `true`
runs the tool, `false` sends the model a rejection. It applies to `send()`,
sessions and `agent.approvals.resolve()`; `stream()` still ends at the pause.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const trusted = createAgent({
  provider,
  tools: [emailTool],
  approve: ({ toolName, args }) => toolName !== 'send_email' || String(args.to).endsWith('@example.com'),
});
```

## `AgentExecutor` and `resumeAfterApproval()`

With `AgentExecutor.execute()` directly, pass an `approvalStore`. On a gated
call the executor persists an `ExecutionSnapshot` instead of invoking the
tool. Resume later, after a real restart if you like, with
`resumeAfterApproval()`:

```ts
import { AgentExecutor, resumeAfterApproval, StorageServiceApprovalStore } from '@loushy/build-ai-agent';

const approvalStore = new StorageServiceApprovalStore(storage);

const paused = await AgentExecutor.execute({
  agent, input, provider, toolRegistry, approvalStore,
});
// paused.finishReason === 'awaiting-approval', paused.approvalId is set

// ...later, from any process, after a human approves...
const result = await resumeAfterApproval(
  { id: paused.approvalId!, approved: true },
  approvalStore,
  toolRegistry,
  provider,
);
```

`resumeAfterApproval(decision, store, registry, provider, options?, checkpointStore?)`
takes most of the execution options of `execute()` (for example `signal`,
`onEvent`, `exporter`). With `sessionId` + `checkpointStore`, the pause is also
checkpointed, and `execute()` with that `sessionId` throws
`SessionAwaitingApprovalError` until the approval is decided, so a pending
approval cannot be bypassed (see [Durable execution](./durable-execution.md)).

| Store | Where the pause lives |
| ----- | --------------------- |
| `InMemoryApprovalStore` | This process only; the default for `createAgent()`. |
| `StorageServiceApprovalStore(storage)` | JSON files through a `StorageService`. |
| `SqliteStore.approvals` | One SQLite file, shared safely by several processes; an approval can be resolved by only one of them. |

## Elsewhere

- **Sub-agents.** A gated tool inside a sub-agent pauses the lead run; the
  lead's `agent.approvals` resolves it. See
  [Approvals inside a sub-agent](./sub-agents.md#approvals-inside-a-sub-agent).
- **Workspace tools.** The shell tool is approval-gated by default. See
  [Workspace tools](./workspace-tools.md).
- **MCP.** Approval-gated tools cannot be approved over MCP; see
  [Serve an agent over MCP](./configuration.md#serve-an-agent-over-mcp).
- **Agent Forge** shows pending approvals as inline cards in its chat; see
  [Agent Forge](./agent-forge.md).
