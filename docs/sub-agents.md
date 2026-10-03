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
| **Handoffs** ([docs](./handoffs.md)) | Another agent should take over the conversation and answer the user itself (triage to a specialist), instead of returning a result to the lead. |
| **Flows** | The steps and their order are known up front (a pipeline), so they should not be left to a model's judgment. |

## Quick start

Give each sub-agent a `description` (the lead model reads it to choose), then
pass them to the lead as `subagents`:

```ts
import { createAgent } from '@lousho/build-ai-agent';

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
   `{ agent: <one of the names>, prompt: string, description: string, background?: boolean, taskId?: string, mode?: 'new' | 'resume' | 'fork' }`
   (`description` is a 3-5 word label used in events and hooks; `taskId` and
   `mode` continue an earlier task, see [Continuing a task](#continuing-a-task)).
3. Three tools for background tasks: `agent_status`, `agent_await` and
   `agent_cancel` (see [Background sub-agents](#background-sub-agents)).

When the lead calls `task`, the named sub-agent runs on `prompt` alone. The
tool result is the sub-agent's final text plus a small footer the lead can
use:

```text
The first bicycles appeared in the 1810s ...

[sub-agent 'researcher': 3 step(s), finish reason 'stop', taskId 'task_1']
```

If the sub-agent does not finish - it throws, runs out of `maxSteps`, or is
aborted - the lead gets an error result (`isError: true`) that says why, for
example `Sub-agent 'researcher' used all 10 of its steps (maxSteps) without
giving a final answer.` An unknown agent name is also an error result listing
the valid names. Sub-agent token usage is added to the lead's `result.usage`,
a [remote sub-agent](#remote-sub-agents)'s too.

Errors at setup time are thrown with a fix: a sub-agent without a
`description`, a value that is not a `createAgent()` agent, or a tool of your
own already named `task` (or `agent_status`, `agent_await`, `agent_cancel`).

## Continuing a task

Each `task` call runs in a child conversation with a `taskId` (`task_1`,
`task_2`, ... in the footer). The lead can come back to it:

| `task` input | What runs |
| --- | --- |
| no `taskId` (`mode: 'new'`) | A fresh sub-agent, as above, with a new `taskId`. |
| `taskId` (`mode: 'resume'`, the default with a `taskId`) | The same sub-agent with its whole transcript (its earlier prompts, tool calls and answers) and `prompt` as the next user turn. The result keeps the `taskId`. |
| `taskId` and `mode: 'fork'` | A new task (new `taskId`) that starts from a copy of that transcript. The original task is left as it was and can still be resumed. |

The model learns this from the `task` tool description, so asking a follow-up
needs no code. A lead that keeps its work across turns or restarts needs a
store and a session:

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db');
const researcher = createAgent({ provider, instructions: 'You research.', description: 'Finds and summarizes sources' });
const lead = createAgent({ provider, instructions: 'You coordinate research.', store, subagents: { researcher } });

const chat = lead.session({ id: 'user-42' });
await chat.send('Research the history of the bicycle.'); // the lead calls task -> taskId 'task_1'
await chat.send('Ask the researcher which source it trusted most.'); // the lead calls task({ taskId: 'task_1', ... })
```

Where the conversations live:

- With `createAgent({ store })` (`store.sessions`) and a lead run that has a
  `sessionId` (a checkpointed `send(message, { sessionId })` or a session
  turn), each task is saved in `store.sessions` after its run, under a key
  hashed from the lead session id and the `taskId`. They outlive the lead run:
  later turns of the same session, a lead resumed with `agent.resume()` or
  `approvals.resolve()`, and a new process on the same durable store can
  continue them. A `taskId` from another lead session never matches. The
  session store has no list API, so these entries are not listed or deleted
  with the lead session; delete the store's data to drop them. For
  `AgentExecutor.execute()`, set the store with
  `withSubagentOptions(subagents, { sessions })`.
- Otherwise (no session store, or a lead run without a `sessionId`) a task
  lives in memory for that one `execute()` / `send()` call: a run that pauses
  for approval and is resumed starts with none. A sub-agent that the approval
  itself resumes still answers the lead (as the `task` or `agent_await`
  result), but it cannot be continued by `taskId` afterwards; use a session
  store for that.

Only tasks that finished (`stop`, `length` or `max-steps`) are saved, so a
task that failed or was cancelled cannot be continued. Errors reach the lead
as structured tool errors: an unknown `taskId`, one of another lead session,
or one that belongs to another sub-agent fails with
`LOUSHO_SUBAGENT_TASK_NOT_FOUND`; a task that is still running (a background
task that has not ended) fails with `LOUSHO_SUBAGENT_TASK_BUSY`, telling the
model to `agent_await` or `agent_cancel` it first.

A resumed or forked task is a normal `task` call otherwise: it can run in the
background (it keeps its `taskId`), an approval inside it pauses and resumes
the lead like any sub-agent approval, and its usage counts toward the lead's
`usage` and `limits`. The child sees its whole transcript again on every
resume, so a long-lived task costs more tokens each time.

## Parallel tasks

Tool calls of one model turn run concurrently (see `toolConcurrency`), so when
the lead calls `task` several times in one turn, those sub-agents run in
parallel. Results reach the lead's transcript in the order the model made the
calls. Cap it with `toolConcurrency` on the lead (`1` runs them one at a time).

## Background sub-agents

With `background: true`, `task` starts the sub-agent and returns at once with
`{ taskId, status: 'running', agent }`, so the lead can keep working (or start
more tasks) while it runs. The lead then uses:

| Tool | Input | Result |
| --- | --- | --- |
| `agent_status` | `{ taskId? }` | `{ tasks: [{ taskId, agent, status, elapsedMs, approvalId?, toolName?, error? }] }` for one task or all of them. `status` is `queued`, `running`, `done`, `failed`, `cancelled` or `awaiting-approval`. |
| `agent_await` | `{ taskId }` or `{ taskIds }`, optional `timeoutMs` | Waits until the task(s) end. A `done` task carries `result`: the same text (with footer) a synchronous `task` returns. A `failed` one carries `error`. A task still running after `timeoutMs` reports `status: 'timeout'`. With `taskIds` the result is `{ tasks: [...] }`. |
| `agent_cancel` | `{ taskId }` | Cancels a queued or running task (its run is aborted) and returns its status. |

At most `maxConcurrent` background sub-agents of one lead run run at once
(default 3); further `background: true` calls get `status: 'queued'` and start
as slots free. Set it with `subagentOptions` on `createAgent()`:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const researcher = createAgent({ provider, instructions: 'You research.', description: 'Finds and summarizes sources' });

const lead = createAgent({
  provider,
  instructions: 'You coordinate research.',
  subagents: { researcher },
  subagentOptions: { maxConcurrent: 2, awaitBackgroundOnFinish: true },
});
```

For `AgentExecutor.execute()`, attach the same options to the `subagents`
value with `withSubagentOptions(subagents, options)`, which returns it. On
`createAgent()`, `subagentOptions` override options attached that way.

A background sub-agent inherits from the lead run like a synchronous one
(hooks, tracing, event listeners, usage roll-up), and `maxSubagentDepth` applies the
same way. Aborting the lead's signal cancels its background sub-agents, queued
or running.

### When the lead run ends

Background tasks belong to one run (one `execute()` / `send()` / `stream()`).
When that run ends, however it ends, the tasks still queued or running are
**cancelled** by default (their runs are aborted). With
`awaitBackgroundOnFinish: true` the run instead waits for them to finish
before it resolves (an aborted or failed lead run still cancels them). Either
way the run resolves only once their runs have stopped, so no sub-agent event
reaches the run's listeners after it; with `awaitBackgroundOnFinish` their
events arrive before the lead's `run.done`.

The result lists every background task of the run with its final status:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const researcher = createAgent({ provider, instructions: 'You research.', description: 'Finds and summarizes sources' });
const lead = createAgent({ provider, instructions: 'You coordinate research.', subagents: { researcher } });

const result = await lead.send('Research three topics in the background.');
for (const task of result.backgroundTasks ?? []) {
  console.log(task.taskId, task.agent, task.status); // e.g. task_1 researcher cancelled
}
```

`result.backgroundTasks` holds `{ taskId, agent, status, elapsedMs, error?,
approvalId?, toolName? }` per task (the `agent_status` shape) and is absent
when the run started none. Use `agent_await` in the lead (the system prompt
tells it to) to get their answers into the conversation.

The executor hook behind this is public: `ExecuteOptions.onRunEnd` is called
exactly once per run, with `{ result }` (whatever the `finishReason`) or
`{ error }`; the run settles after it returns. Background tasks are reported
on `result` before your `onRunEnd` sees it.

Limits:

- A lead run that pauses for approval (`finishReason: 'awaiting-approval'`)
  ends there: its background tasks still queued or running are cancelled (or
  awaited) like at any other end, and the resumed run starts with none. The
  resumed run is a separate run with no link to the paused one's tasks (it
  may even run in another process), so they cannot be kept alive across the
  pause.
- A background sub-agent that needs approval stops with
  `status: 'awaiting-approval'` (with the child's `approvalId` and
  `toolName`); its call does not run yet. It continues only when the lead
  waits for it with `agent_await` (the `task` and `agent_status` tool
  descriptions tell the model so). Then the **lead pauses** on that approval,
  like for a synchronous sub-agent: the lead's result has
  `finishReason: 'awaiting-approval'`, the pending approval names the child's
  call with `subagentPath: ['<agent>']`, and it is listed by
  `agent.approvals.list()`. `approvals.resolve()` (or `resume()` after a
  restart, with a durable store) runs or rejects the child's call, lets the
  child finish, and the continued lead gets the child's answer as the
  `agent_await` result (`status: 'done'` with `result`, or `'failed'`). The
  child's usage is added to the lead's, and its conversation is saved under
  its `taskId` like any task's, so `task({ taskId })` can continue it.
- If the child pauses again, the lead pauses again with the next approval. If
  one `agent_await` call waits on several tasks that are all paused, the lead
  pauses on them one after another, then that call returns every answer at
  once.
- A task that is still `awaiting-approval` when the lead ends without having
  awaited it is reported in `result.backgroundTasks` with that status and
  cannot be resumed: the model chose not to wait for it.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const shell = defineTool({
  name: 'shell',
  description: 'Runs a shell command',
  input: z.object({ cmd: z.string() }),
  needsApproval: true,
  execute: async ({ cmd }) => `ran ${cmd}`,
});
const coder = createAgent({ provider, instructions: 'You code.', tools: [shell], description: 'Fixes code' });
const lead = createAgent({ provider, instructions: 'You lead.', subagents: { coder } });

// The lead starts `coder` with task({ background: true }), then calls agent_await on it.
const paused = await lead.send('Fix the failing test in the background, then report.');
if (paused.finishReason === 'awaiting-approval' && paused.approvalId) {
  const [pending] = await lead.approvals.list(); // { toolName: 'shell', args: { cmd: ... }, subagentPath: ['coder'] }
  console.log(pending?.toolName, pending?.args);
  const result = await lead.approvals.resolve({ id: paused.approvalId, approved: true });
  console.log(result.text); // agent_await returned the coder's answer to the lead
}
```

## Dynamic catalogs

Instead of a fixed record, pass a catalog with `list()` and `resolve(name)`.
`list()` is called at the start of every run that offers the `task` tool, so
the set can change between runs; `resolve()` is called when the lead picks a
name (return `undefined` for an unknown one).

```ts
import { createAgent, type SubagentCatalog } from '@lousho/build-ai-agent';

const experts = new Map([
  ['researcher', createAgent({ provider, instructions: 'You research.' })],
]);

const catalog: SubagentCatalog = {
  list: async () => [{ name: 'researcher', description: 'Finds and summarizes sources' }],
  resolve: async (name) => experts.get(name),
};

const lead = createAgent({ provider, instructions: 'You coordinate.', subagents: catalog });
```

## Remote sub-agents

`remoteAgent()` uses an agent you already deployed (`lousho deploy`: the node
server, Docker or a Cloudflare Worker) as a sub-agent. It goes in `subagents`
next to local ones, and the lead delegates to it with the same `task` tool,
including `background: true`.

```ts
import { createAgent, remoteAgent } from '@lousho/build-ai-agent';

const lead = createAgent({
  provider,
  instructions: 'You coordinate.',
  subagents: {
    researcher: remoteAgent({
      url: 'https://researcher.example.workers.dev',
      auth: process.env.RESEARCHER_TOKEN, // the deployment's LOUSHO_API_TOKEN; or () => string | Promise<string>
      description: 'Finds and summarizes sources',
    }),
  },
});
```

Each task opens a new session on the remote agent (`POST <url>/chat` with
`{ sessionId, input }`, read as the SSE event stream, see
[Deployment](./deployment.md#http-api)), sends the task prompt and returns the
remote agent's final text (its object as JSON when the deployed agent has an
`output` schema, see [Structured output](./structured-output.md)), followed by
a footer naming the session and the `taskId`. A `task` call that resumes that `taskId` posts to the same remote
session, so the remote agent continues with its own history (keep it in a
store on the remote side); a remote task cannot be forked. The remote
agent sees only that prompt, and runs with its own model, tools and limits, so
the lead's runtime (hooks, sandbox, approval store) does not reach it. The
lead run's abort signal aborts the request. Options: `url`, `auth`, `name`,
`description`, `headers`, and `fetch` (inject one in tests; the
`serveFetch()` routes of an in-process agent work as a fake deployment).

Failures (the agent is unreachable, a 401 or other non-2xx answer, a malformed
stream, or a remote run that ends in an error) reach the lead as the
structured tool error with the code `LOUSHO_REMOTE_REQUEST_FAILED` (`LOUSHO_REMOTE_UNAUTHORIZED` for a 401); the token is
never part of an error or an event.

The remote run's token usage, as the remote agent reports it on its `run.done`
event, is added to the lead's `result.usage`: to the totals, to
`usage.delegated`, and to `byModel['remote:<name>']` (`<name>` is the key in
`subagents`). The remote sends no per-model breakdown, so that one entry holds
its totals and the remote's own `costUsd` estimate; when the remote sends no
cost, the lead's `costUsd` becomes `undefined`. The lead trusts these numbers:
it cannot check them. A deployment from before this change sends no usage, and
then nothing is added. A remote run that pauses for an approval adds what it
spent up to the pause, and the continuation adds only what it spent after it.
The usage arrives when the remote run ends, so the lead's `limits` see it only
after the `task` call returns. A hand-written `RemoteSubagent` gets the
per-turn usage through the `onUsage` option of its `run()`.

### Remote approvals

If the remote run pauses for an approval, the lead run pauses on it exactly as
for a local sub-agent: `result.finishReason` is `'awaiting-approval'`, and the
pending approval in `agent.approvals.list()` (and in channel buttons, the dev
chat and ACP permission requests) has the remote tool's name and input, with
`subagentPath: ['researcher']`. A remote `ask_question` call arrives as a
question (`kind: 'question'`) that `agent.approvals.answer()` answers.
Deciding it on the lead (`resolve`, `streamResolve`, `answer`) posts the
decision to the remote agent's approvals route
(`POST <url>/chat/<session>/approvals/<id>`), reads the continuation, and its
final answer becomes the `task` result; a continuation that pauses again pauses
the lead again.

```ts
import type { SimpleAgent } from '@lousho/build-ai-agent';
declare const lead: SimpleAgent; // the lead agent above

const paused = await lead.send('Deploy the docs site');
if (paused.finishReason === 'awaiting-approval') {
  const [pending] = await lead.approvals.list(); // e.g. { toolName: 'deploy', args: {...}, subagentPath: ['researcher'] }
  const result = await lead.approvals.resolve({ id: pending.id, approved: true });
  console.log(result.text);
}
```

The lead's approval snapshot keeps only the remote session id, the remote
approval id, the `taskId` and the sub-agent's name, so a fresh lead process on
the same store can decide it; the bearer token is never stored (it is read from
the `remoteAgent()` options again). A failure while deciding (a 401, any other
non-2xx answer such as the remote's 404 for an approval no longer pending, a
network error) is the structured tool error of that `task` call with the codes
above, and the lead run continues. Only a run without an approval store (a bare
`AgentExecutor`) still fails the task with `LOUSHO_SESSION_AWAITING_APPROVAL`,
naming the remote session and approval id to decide on the remote agent.

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
| Event listeners (`onAgentEvent`, `createAgent({ onEvent })`) and `stream()` | Yes | The sub-agent's events are forwarded with a `subagent` field. |
| `toolConcurrency` | Yes, unless the sub-agent sets its own | |
| `sandbox` | Yes | |
| Token usage | Rolls up | Added to the lead's `result.usage` (totals, `byModel`, and `usage.delegated`); a remote sub-agent's under `byModel['remote:<name>']`. |
| `maxSubagentDepth` | The remaining budget | See [Depth](#depth). |
| `permissionMode` | Yes, unless the lead's is `'default'` | The sub-agent runs under the lead's [permission mode](./permission-modes.md#sub-agents), read at each of its tool calls; while the lead's is `'default'`, under its own (a sub-agent whose own mode is `'plan'` always stays in plan mode). A remote sub-agent does not inherit it: plan mode refuses a `task` call to one. |
| `onLLMRequest`, `onToolCall` and the other single-run callbacks | No | They describe one run; use hooks or an event listener to observe sub-agents. |
| `sessionId` / `checkpointStore` | No | A sub-agent is not checkpointed on its own. If the process dies while a sub-agent runs, the resumed lead runs that `task` call again. |
| `output` schema | No | A sub-agent's output is its own: with one, `task` returns its validated object as JSON (see [Structured output](./structured-output.md#sub-agents)); without, text. |
| Conversation history | No | The sub-agent sees only the task prompt (plus its own earlier turns when the lead [resumes the task](#continuing-a-task)). |

`createDelegateTool()` children inherit the same way.

### Hooks inside sub-agents

See [Hooks](./hooks.md) for the hook points and outcomes.

A parent's hooks apply to its sub-agents by default. `ctx.subagent` tells a
hook it is running inside one - the sub-agent's `name`, its `depth` (1 for a
sub-agent of the top-level run), the lead's `toolCallId` that started it, and
the enclosing sub-agent as `parent` when nested deeper. A hook that should only
see the top-level run returns early:

```ts
import { HookRegistry } from '@lousho/build-ai-agent';

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

A listener on the lead (`createAgent({ onEvent })` or `onAgentEvent`) gets
the same events, sub-agents' included, as they happen. See
[Listening without iterating](./streaming.md#listening-without-iterating).

## Approvals inside a sub-agent

When a sub-agent calls a tool that `needsApproval`, the **whole run pauses**:
the lead's `send()` resolves with `finishReason: 'awaiting-approval'` and
an `approvalId`, and the approval store holds ONE record whose pending call is
the sub-agent's call (`toolName`, `args`) with `subagentPath` naming the
sub-agents it runs inside (e.g. `['researcher']`). Approve or reject it with
`lead.approvals.resolve({ id, approved })` (the lead already knows its
`subagents`; the in-memory approval store is the default, so no `approvalStore`
is needed):

```ts
import { createAgent } from '@lousho/build-ai-agent';

const lead = createAgent({
  provider,
  instructions: 'You lead.',
  subagents: { researcher: createAgent({ provider, instructions: 'You research.', description: 'Researches' }) },
});

const paused = await lead.send('Go');
if (paused.finishReason === 'awaiting-approval' && paused.approvalId) {
  const result = await lead.approvals.resolve({ id: paused.approvalId, approved: true });
  console.log(result.text);
}
```

Resuming runs (or rejects) the sub-agent's pending call, lets the sub-agent
finish, returns its final answer to the lead as the `task` result, and then
continues the lead. If the sub-agent needs another approval, the run pauses
again with a new `approvalId`. This works at any depth and for
`createDelegateTool()` children (pass the registry that holds the delegate
tool).

The lead's `approve` option decides its sub-agents' calls too.

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
- A sub-agent whose definition changed since the pause (instructions, model
  or tools) is handled by the lead's `onAgentDrift`, like the lead itself:
  `'error'` rejects the resume and leaves the approval pending, `'warn'` (the
  default) warns and emits `agent.drift` with `subagent` set. A sub-agent that
  no longer has the approved call's tool always rejects with
  `LOUSHO_RESUME_TOOL_MISSING`. See
  [Resuming with a changed agent](./durable-execution.md#resuming-with-a-changed-agent).
- Token usage keeps adding up across the pause: the sub-agent's usage before
  the pause is in the paused result, and what it spends after the resume is
  added to the resumed lead's `result.usage`.
- A background sub-agent's approval pauses the lead when the lead awaits it
  with `agent_await`; see [Background sub-agents](#when-the-lead-run-ends).

#### Advanced: the executor API

With `AgentExecutor.execute()` as the lead (see
[the executor API](./executor-api.md)), the run needs an `approvalStore`;
without one, the sub-agent's call becomes an error result and nothing runs.
Resume with `resumeAfterApproval()`, passing the same `subagents` option as the
paused run:

```ts
import { AgentExecutor, resumeAfterApproval, ToolRegistry, createAgent } from '@lousho/build-ai-agent';

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

## `createDelegateTool()`

`createDelegateTool()` is superseded by `subagents`; it exists for code that
builds a `ToolRegistry` by hand.

`createDelegateTool({ agent, provider, toolRegistry })` wraps one child agent as
a tool you name and register yourself, with its own `maxDepth` guard. It runs
on the same delegation core as `task`, so it inherits the parent runtime the
same way, and its result shape (`{ text, usage }`) is unchanged. Prefer
`subagents` for new code: one tool, a prompt listing, parallel tasks and depth
limits come for free.

```ts
import { AgentExecutor, createDelegateTool, ToolRegistry } from '@lousho/build-ai-agent';

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
