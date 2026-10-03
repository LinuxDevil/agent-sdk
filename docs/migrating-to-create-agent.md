# Migrating to createAgent()

This page is for code that uses `AgentBuilder`, `AgentExecutor`, `ToolRegistry` and
`resumeAfterApproval()`: the lower-level API the SDK started with. Those exports keep
working and this page does not remove them; if you stay on them, see
[The executor API](./executor-api.md). The reason to move is that one
`createAgent()` call wires tools, stores, approvals, sessions, retries and
compaction, where the executor makes you assemble each of them and pass them to every
call.

`createAgent()` does not take every option the executor takes yet; see
[What createAgent() does not take yet](#what-createagent-does-not-take-yet) before you
start.

## Before and after

One agent with a tool that needs approval, first with the executor API, then with
`createAgent()`. Both use a scripted model, so they run offline and end with the same
text, `Sent the report to Sam.`, after the same pause.

```ts
import {
  AgentBuilder,
  AgentExecutor,
  InMemoryApprovalStore,
  ToolRegistry,
  defineTool,
  resumeAfterApproval,
} from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

const provider = mockModel([
  { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
  'Sent the report to Sam.',
]);

// Before: the agent, the tool registry, the approval store and the provider are
// separate objects, and the resume call needs all of them again.
const agent = AgentBuilder.create().setName('Mailer').setPrompt('You send emails.').addTool(sendEmail).build();
const toolRegistry = new ToolRegistry();
toolRegistry.register(sendEmail);
const approvalStore = new InMemoryApprovalStore();

const paused = await AgentExecutor.execute({
  agent,
  input: 'Email the report to Sam',
  provider,
  toolRegistry,
  approvalStore,
});
console.log(paused.finishReason); // 'awaiting-approval'

const result = await resumeAfterApproval(
  { id: paused.approvalId!, approved: true },
  approvalStore,
  toolRegistry,
  provider,
);
console.log(result.text); // 'Sent the report to Sam.'
```

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

// After: the same scripted model gives the same result as the snippet above.
const mailer = createAgent({
  provider: mockModel([
    { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
    'Sent the report to Sam.',
  ]),
  instructions: 'You send emails.',
  tools: [sendEmail],
});

const paused = await mailer.send('Email the report to Sam');
console.log(paused.finishReason); // 'awaiting-approval'

const result = await mailer.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log(result.text); // 'Sent the report to Sam.'
```

The tool is the same `defineTool()` result in both. The agent keeps its own registry,
approval store and provider, so deciding the pause needs only the approval id.

## Mapping

| Legacy | `createAgent()` |
| ------ | --------------- |
| `AgentBuilder.create().setName(n).setPrompt(p).build()` | `createAgent({ name, instructions })` (`prompt` is an alias of `instructions`). |
| `addTool(key, config)` on the builder, plus `ToolRegistry.register(tool)` | `tools: [defineTool(...)]`. There is no registry to build; see [Tools](./tools.md). |
| `AgentExecutor.execute({ agent, input, provider })` | `agent.send(message)`. The model is `model` (a `provider/model` string) or `provider`. |
| `AgentExecutor.stream(...)` | `agent.stream(message)`; see [Streaming](./streaming.md). |
| `onAgentEvent` | `onEvent` on `createAgent()`; `stream()` gives the same events. |
| `onEvent` with `ExecutionEvent` (deprecated) | `AgentEvent` listeners; see [Migrating from `onEvent` / `ExecutionEvent`](./streaming.md#migrating-from-onevent--executionevent). |
| `sessionId` + `checkpointStore` | `store` on `createAgent()` and `agent.send(message, { sessionId })`; finish an interrupted run with `agent.resume(sessionId)`. See [Durable execution](./durable-execution.md). |
| `approvalStore` | `approvalStore`, or `store` with `approvals`. Without either, a per-agent `InMemoryApprovalStore`. |
| `resumeAfterApproval(decision, store, registry, provider)` | `agent.approvals.resolve({ id, approved, note? })`; `agent.approvals.answer()` for a question. See [Approvals](./approvals.md). |
| `streamResumeAfterApproval(...)` | `agent.approvals.streamResolve(...)` and `streamAnswer(...)`. |
| `AgentExecutor.fork(...)` | `agent.fork(sessionId, { fromStep, patch })`. |
| `hooks: HookRegistry` | `hooks: AgentHook[]`. |
| `signal` | `agent.send(message, { signal })`. |
| `maxSteps`, `limits`, `guardrails`, `toolConcurrency`, `onAgentDrift`, `reasoning`, `output` | The same names on `createAgent()`; `reasoning` can also be set per `send()`. |
| `exporter`, `captureContent`, `redactContent` | The same names on `createAgent()`. |
| `skills`, `subagents` | The same names on `createAgent()`, which also takes `mcpServers` and `memory`. |
| `inputQueue` | `run.enqueue()` on a streamed run, or `agent.session({ turnPolicy })`; see [Queued input](./queue-and-steer.md#queued-input). |
| `sessionBudget` | `agent.session({ id, limits })`; see [Sessions](./sessions.md). |
| `createDelegateTool()` | `subagents`; see [Sub-agents](./sub-agents.md). |
| `AgentType`, `setType()` | Nothing to move: the type has no effect. |

## What createAgent() does not take yet

These `ExecuteOptions` have no `createAgent()` option. Where there is a supported
alternative it is named; otherwise keep that call on `AgentExecutor.execute()`.

| Executor option | Alternative |
| --------------- | ----------- |
| `temperature`, `maxTokens` | None: stay on the executor. (`limits.maxTokens` is a budget for the run, not a generation setting.) |
| `sandbox` | None: stay on the executor. |
| `onLLMRequest`, `onLLMResponse` | A `preGenerate` / `postGenerate` hook in `hooks`, or an `onEvent` listener. |
| `onToolCall`, `onToolResult` | A `preToolCall` / `postToolCall` hook in `hooks`, or an `onEvent` listener. |
| `onRunEnd` | An `onEvent` listener for `run.done`, or the result of `send()`. |
| `businessState` | None: stay on the executor. |

A run uses one API or the other: an agent that needs one of the "None" rows keeps that
call on the executor, and can use `createAgent()` for the rest of the code.

## Behavior differences

- `send()` is one turn. A conversation is a separate object, `agent.session()`, which
  keeps the transcript and sends it with each turn; see [Sessions](./sessions.md). Code
  that built a message history by hand moves to a session.
- A paused run resolves. A `send()` that reaches a `needsApproval` tool resolves with
  `finishReason: 'awaiting-approval'` and an `approvalId`; it does not throw. The pause
  stays with the agent, so `agent.approvals.list()` shows it and `resolve()` continues
  it without the registry or provider.
- The default approval store is per agent and in memory. A pause survives a restart only
  with a durable `store` or `approvalStore`; see
  [Choosing a store](./sessions.md#choosing-a-store).
- Retries are on by default for a `model` string: two retries of a failed model call. A
  `provider` instance you pass is not wrapped unless you set `retry`. See
  [Provider retries and fallback](./configuration.md#provider-retries-and-fallback).

## Migrating step by step

1. Tools first. Keep the `defineTool()` tools; drop the `ToolRegistry` and any
   `addTool(key, config)` call, and list the tools in `tools`.
2. Replace `AgentBuilder` with `createAgent({ name, instructions, tools })`, and pass
   `model` or the `provider` you already pass to `execute()`.
3. Replace each `AgentExecutor.execute()` with `agent.send()` and each `stream()` with
   `agent.stream()`. Move `maxSteps`, `limits` and the other shared options to
   `createAgent()`. Keep a call on the executor if it needs an option from the "does
   not take yet" list.
4. Replace `resumeAfterApproval()` with `agent.approvals.resolve()`. If approvals must
   outlive the process, pass the store you used as `approvalStore`.
5. Move `checkpointStore` and its `sessionId` to `store`, and pass `sessionId` to
   `send()`. Use `agent.session()` where you kept a history yourself.
6. Replace `onEvent` with `ExecutionEvent` by an `AgentEvent` listener, then move
   `HookRegistry` hooks into `hooks`.
