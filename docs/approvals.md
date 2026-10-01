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

MCP tools set `needsApproval` from the server's tool annotations: `readOnlyHint:
true` runs, while `destructiveHint` true or absent (the MCP default) asks. Choose
per server with `approval: 'annotations' | 'always' | 'never'` or a function; see
[MCP tool approval](./configuration.md#mcp-tool-approval-approval).

## Permission policies

`permissions` sets rules for the whole agent instead of tool by tool: a list of
`{ tool, when?, action, reason? }` rules, checked in order for every tool call
before the tool's own `needsApproval`. The first rule that matches decides:

- `allow` runs the call, without approval even if `needsApproval` would ask.
- `deny` does not run it. The model gets a tool error with `kind: 'denied'`
  and the rule's `reason` (see [Tool errors](./tools.md)), and streams see
  `tool.error`.
- `ask` pauses the run for approval, exactly like `needsApproval` (or asks the
  `approve` callback).

When no rule matches, the tool's own `needsApproval` decides, as before.
`tool` is a name, a list of names, a `RegExp` tested against the name, or
`'*'` for every tool. `when` narrows a rule to some calls: it gets the
validated arguments (after `preToolCall` hooks) and `{ toolName, toolCallId,
sessionId }`, and may be async; when it throws, the call fails with that
error. `allow(tools)`, `deny(tools, reason?)` and `ask(tools)` build the
common rules.

```ts
import { allow, ask, createAgent, defineTool, deny, type PermissionRule } from '@loushy/build-ai-agent';
import { z } from 'zod';

const shell = defineTool({
  name: 'shell',
  description: 'Run a shell command',
  input: z.object({ command: z.string() }),
  execute: async ({ command }) => `ran ${command}`,
});

const noDeletes: PermissionRule = {
  tool: 'shell',
  when: (args) => /\brm\b/.test(String(args.command)),
  action: 'deny',
  reason: 'Deleting files is not allowed',
};

const agent = createAgent({
  provider,
  instructions: 'You are a coding assistant.',
  tools: [shell],
  permissions: [
    noDeletes, // first match wins: this beats the `ask` below
    allow(/^read_/), // read-only tools never pause
    deny('delete_file', 'Use the trash tool instead'),
    ask(['shell', 'write_file']),
  ],
  onPermissionDecision: (entry) => console.log(entry.at, entry.toolName, entry.decision, entry.rule?.reason),
});
```

`onPermissionDecision` is the audit log: it is called once per tool call
(except calls already refused for invalid arguments) with
`{ toolName, toolCallId, decision, rule?, args?, at }`. `decision` is the
matching rule's action or `'default'` when none matched, `rule` is that rule's
`{ index, reason? }`, `at` is an ISO timestamp, and `args` is left out when the
run sets `redactContent`. Streams get the same entry as a `permission.decision`
event (see [Streaming](./streaming.md)). Both are only produced when the agent
sets `permissions` or `onPermissionDecision`.

Both options also exist on `AgentExecutor.execute()` / `stream()` and
`resumeAfterApproval()`. Sub-agents inherit the lead agent's rules, checked
before the sub-agent's own, and report their decisions to the lead's
`onPermissionDecision`.

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

## Asking the user a question

`createAgent({ askQuestion: true })` gives the agent the built-in
`ask_question` tool (off by default; `askQuestionTool()` returns the same tool
to pass in `tools` yourself). Its input is
`{ question: string; options?: string[]; allowFreeText?: boolean }`. A call
pauses the run through the approval mechanism, so it waits exactly like an
approval: in sessions, in durable stores and across a restart.

- The pending record has `kind: 'question'` and
  `question: { text, options?, allowFreeText? }`, in `agent.approvals.list()`,
  in the `approve` callback and on the `approval.requested` event, so a UI can
  render a question instead of an approve button.
- `agent.approvals.answer({ id, answer })` (the same as
  `resolve({ id, approved: true, note: answer })`) continues the run. The
  model gets `{ answer, option? }`, where `option` is the index of the matching
  entry of `options` (case-insensitive). With `allowFreeText: false`, an answer
  outside the options reaches the model as a tool error.
- `resolve({ id, approved: false, note? })` declines: the model gets a
  `kind: 'rejected'` tool error saying the user declined to answer.
- An `approve` callback may return a string to answer in code, which is handy
  in tests and scripted agents.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ prompt: 'Plan the trip with the user.', provider, askQuestion: true });

const paused = await agent.send('Book me a weekend away');
const [pending] = await agent.approvals.list();
if (paused.approvalId && pending?.kind === 'question') {
  console.log(pending.question?.text, pending.question?.options);
  const result = await agent.approvals.answer({ id: paused.approvalId, answer: 'Lisbon' });
  console.log(result.text);
}

// Scripted: answer every question in code.
const scripted = createAgent({
  provider,
  askQuestion: true,
  approve: (request) => (request.kind === 'question' ? 'Lisbon' : false),
});
```

A permission rule that `allow`s `ask_question` skips the pause, so the call
fails with "No answer"; leave the tool to its default.

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
