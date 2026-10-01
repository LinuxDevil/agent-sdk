# Sub-agents

A sub-agent is a separate agent - its own instructions, model, tools and
skills - that a lead agent hands a self-contained task to. The sub-agent
starts with a clean context (it sees only the task prompt, never the lead's
conversation), works through as many steps as it needs, and its final answer
comes back to the lead as one tool result.

## Sub-agents, skills or flows?

| Use | When |
| --- | --- |
| **Skills** ([docs](./skills.md)) | The *same* agent needs extra instructions for some tasks. Cheap: a skill is text loaded into the current conversation. |
| **Sub-agents** | A task needs different tools, a different model, or a long tool-heavy exploration you do not want in the lead's context. The lead decides at run time whether and what to delegate; independent tasks run in parallel. |
| **Flows** | The steps and their order are known up front (a pipeline), so they should not be left to a model's judgment. |

## Quick start

Give each sub-agent a `description` (the lead model reads it to choose), then
pass them to the lead as `subagents`:

```ts
import { createAgent } from '@loushy/build-ai-agent';

const researcher = createAgent({
  provider,
  instructions: 'You research a question and report your sources.',
  description: 'Finds and summarizes sources',
});
const writer = createAgent({
  provider,
  instructions: 'You write clear, short articles.',
  description: 'Turns notes into a polished article',
});

const lead = createAgent({
  provider,
  instructions: 'You coordinate research and writing.',
  subagents: { researcher, writer },
});

const { text } = await lead.send('Write a short article about the history of the bicycle.');
```

`AgentExecutor.execute()` takes the same `subagents` and `maxSubagentDepth`
options. Use it when you need hooks or tracing on the lead run - sub-agents
inherit those (see [Inheritance](#what-a-sub-agent-inherits)). Approvals work
from `createAgent()` too (see [Approvals](#approvals-inside-a-sub-agent)).

## How it works

With `subagents`, the lead agent gets:

1. An **Available sub-agents** block in its system prompt: one line per
   sub-agent (`- name: description`), plus a sentence saying that a sub-agent
   sees only the prompt it is given.
2. ONE tool, `task`, with the input
   `{ agent: <one of the names>, prompt: string, description: string }`
   (`description` is a 3-5 word label used in events and hooks).

When the lead calls `task`, the named sub-agent runs on `prompt` alone. The
tool result is the sub-agent's final text plus a small footer the lead can
use:

```text
The first bicycles appeared in the 1810s ...

[sub-agent 'researcher': 3 step(s), finish reason 'stop']
```

If the sub-agent does not finish - it throws, runs out of `maxSteps`, or is
aborted - the lead gets an error result (`isError: true`) that says why, for
example `Sub-agent 'researcher' used all 10 of its steps (maxSteps) without
giving a final answer.` An unknown agent name is also an error result listing
the valid names. Sub-agent token usage is added to the lead's `result.usage`.

Errors at setup time are thrown with a fix: a sub-agent without a
`description`, a value that is not a `createAgent()` agent, or a tool of your
own already named `task`.

## Parallel tasks

Tool calls of one model turn run concurrently (see `toolConcurrency`), so when
the lead calls `task` several times in one turn, those sub-agents run in
parallel. Results reach the lead's transcript in the order the model made the
calls. Cap it with `toolConcurrency` on the lead (`1` runs them one at a time).

## Dynamic catalogs

Instead of a fixed record, pass a catalog with `list()` and `resolve(name)`.
`list()` is called at the start of every run that offers the `task` tool, so
the set can change between runs; `resolve()` is called when the lead picks a
name (return `undefined` for an unknown one).

```ts
import { createAgent, type SubagentCatalog } from '@loushy/build-ai-agent';

const experts = new Map([
  ['researcher', createAgent({ provider, instructions: 'You research.' })],
]);

const catalog: SubagentCatalog = {
  list: async () => [{ name: 'researcher', description: 'Finds and summarizes sources' }],
  resolve: async (name) => experts.get(name),
};

const lead = createAgent({ provider, instructions: 'You coordinate.', subagents: catalog });
```

## Depth

`maxSubagentDepth` (default `1`) bounds how deep sub-agents nest. With the
default, the lead can call sub-agents but they cannot call sub-agents of their
own: a run at the limit is simply not offered the `task` tool, even if it was
created with `subagents`. `maxSubagentDepth: 2` lets the lead's sub-agents
delegate once more. The top-level run's value applies to the whole tree; a
sub-agent's own `maxSubagentDepth` only matters when it runs as a top-level
agent.

## What a sub-agent inherits

The sub-agent keeps its own instructions, model/provider, tools, skills and
`maxSteps`, and its context is isolated. From the run that called it, it
inherits:

| Runtime setting | Inherited? | Notes |
| --- | --- | --- |
| Abort `signal` | Yes | Aborting the lead aborts its sub-agents. |
| Tracing (`exporter`) | Yes | The sub-agent's `invoke_agent` span is a child of the lead's `execute_tool task` span. `captureContent` and `redactContent` are inherited too. |
| Hooks (`hooks`) | Yes | They run on the sub-agent's model calls and tool calls, with `ctx.subagent` set (see below). A hook that throws inside a sub-agent halts the whole run. |
| Approval store (`approvalStore`) | Yes | See [Approvals](#approvals-inside-a-sub-agent). |
| `onEvent` and `stream()` | Yes | The sub-agent's events are forwarded with a `subagent` field. |
| `toolConcurrency` | Yes, unless the sub-agent sets its own | |
| `sandbox` | Yes | |
| Token usage | Rolls up | Added to the lead's `result.usage` (totals, `byModel`, and `usage.delegated`). |
| `maxSubagentDepth` | The remaining budget | See [Depth](#depth). |
| `onLLMRequest`, `onToolCall` and the other single-run callbacks | No | They describe one run; use hooks or `onEvent` to observe sub-agents. |
| `sessionId` / `checkpointStore` | No | A sub-agent is not checkpointed on its own. If the process dies while a sub-agent runs, the resumed lead runs that `task` call again. |
| Conversation history | No | The sub-agent sees only the task prompt. |

`createDelegateTool()` children inherit the same way.

### Hooks inside sub-agents

A parent's hooks apply to its sub-agents by default. `ctx.subagent` tells a
hook it is running inside one - the sub-agent's `name`, its `depth` (1 for a
sub-agent of the top-level run), the lead's `toolCallId` that started it, and
the enclosing sub-agent as `parent` when nested deeper. A hook that should only
see the top-level run returns early:

```ts
import { HookRegistry } from '@loushy/build-ai-agent';

const hooks = new HookRegistry();
hooks.register({
  name: 'audit',
  preToolCall(ctx) {
    if (ctx.subagent) return; // top-level tool calls only
    console.log('tool call', ctx.toolName, ctx.args);
  },
});
```

### Events

`agent.stream()` / `AgentExecutor.stream()` on the lead stream each
sub-agent's run inside the same stream - steps, text deltas, tool events and
errors - with a `subagent` field on every one of its events, so a UI can nest
sub-agent activity under the lead's `task` call (`subagent.toolCallId`). See
[Streaming: sub-agents](./streaming.md#sub-agents).

With `onEvent` on the lead, every event a sub-agent emits (`start`,
`tool-call`, `tool-result`, `text-complete`, `finish`, ...) reaches the same
listener with `event.subagent` set. The lead's own events have no `subagent`
field.

## Approvals inside a sub-agent

When a sub-agent calls a tool that `needsApproval`, the **whole run pauses**:
the lead's `execute()` resolves with `finishReason: 'awaiting-approval'` and
an `approvalId`, and the approval store holds ONE record whose pending call is
the sub-agent's call (`toolName`, `args`) with `subagentPath` naming the
sub-agents it runs inside (e.g. `['researcher']`). Approve or reject it with
`resumeAfterApproval()`, passing the same `subagents` option as the paused run:

```ts
import { AgentExecutor, resumeAfterApproval, ToolRegistry, createAgent } from '@loushy/build-ai-agent';

const subagents = { researcher: createAgent({ provider, instructions: 'You research.', description: 'Researches' }) };

const paused = await AgentExecutor.execute({ agent, input: 'Go', provider, subagents, approvalStore });
if (paused.finishReason === 'awaiting-approval' && paused.approvalId) {
  const result = await resumeAfterApproval(
    { id: paused.approvalId, approved: true },
    approvalStore,
    new ToolRegistry(),
    provider,
    { subagents }
  );
  console.log(result.text);
}
```

Resuming runs (or rejects) the sub-agent's pending call, lets the sub-agent
finish, returns its final answer to the lead as the `task` result, and then
continues the lead. If the sub-agent needs another approval, the run pauses
again with a new `approvalId`. This works at any depth and for
`createDelegateTool()` children (pass the registry that holds the delegate
tool).

With a `createAgent()` lead, `lead.send()` pauses the same way and
`lead.approvals.resolve({ id, approved })` resumes it (the lead already knows
its `subagents`); the lead's `approve` option decides its sub-agents' calls too.

Guarantees and limits:

- No call runs twice and none is lost: the sub-agent's paused state is stored
  inside the lead's approval record (plain JSON, so any `ApprovalStore`
  works), and the approved call runs exactly once, on resume.
- Other tool calls of the same lead turn that finished keep their results and
  are not run again.
- One approval is pending per run. If two sub-agents pause in the same turn,
  the run pauses on the first (in call order); the second sub-agent stops and
  the lead gets an error result for that `task` call saying its call was not
  run, so it can ask again after the approval.
- A `task` call's pre/post tool hooks fire again on resume, like the hooks of
  any approved tool.
- Approvals need an `approvalStore` on the lead run, which `createAgent()`
  does not take yet; use `AgentExecutor.execute()` for the lead. Without one,
  the sub-agent's call becomes an error result and nothing runs.
- Token usage keeps adding up across the pause: the sub-agent's usage before
  the pause is in the paused result, and what it spends after the resume is
  added to the resumed lead's `result.usage`.

## `createDelegateTool()`

`createDelegateTool({ agent, provider, toolRegistry })` wraps one child agent as
a tool you name and register yourself, with its own `maxDepth` guard. It runs
on the same delegation core as `task`, so it inherits the parent runtime the
same way, and its result shape (`{ text, usage }`) is unchanged. Prefer
`subagents` for new code: one tool, a prompt listing, parallel tasks and depth
limits come for free.

```ts
import { AgentExecutor, createDelegateTool, ToolRegistry } from '@loushy/build-ai-agent';

const billingAgent = {
  name: 'Billing Agent',
  prompt: 'You answer billing questions and look up invoices.',
};

const registry = new ToolRegistry();
registry.register(
  'delegate_billing_agent',
  createDelegateTool({
    agent: billingAgent,
    provider,
    contextMode: 'none', // 'full-history' shares the parent's context array too
    maxSteps: 10,
    maxDepth: 3, // bounds a delegation chain (e.g. A -> B -> A) before it throws
  })
);

const supportAgent = {
  name: 'Support Agent',
  prompt: 'You help customers. Delegate billing questions to the billing agent.',
  tools: { delegate_billing_agent: { tool: 'delegate_billing_agent' } },
};

const result = await AgentExecutor.execute({
  agent: supportAgent,
  input: 'Why was I charged twice this month?',
  provider,
  toolRegistry: registry,
});
```
