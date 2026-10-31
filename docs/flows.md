# Flows

A flow is a fixed, multi-step workflow run by one agent: the steps and their
order are written down up front instead of being left to the model's judgment.
Describe the graph with `FlowBuilder` and run it with the static
`FlowExecutor.execute(flow, context, onEvent?)`.

```ts
import { FlowBuilder, FlowExecutor, type EditorStep } from 'lousho/flows';
import { resolveProvider, type AgentConfig } from 'lousho';

// A flow calls an LLMProvider directly (reads OPENAI_API_KEY).
const provider = resolveProvider('openai/gpt-4o-mini');
// A plain agent config: `prompt` is every llmCall's system message.
const agent: AgentConfig = { name: 'triage', prompt: 'You are a support triager.' };

// FlowBuilder is a metadata builder: setCode/setName/setInputs/setFlow(...).build().
// EditorStep covers every node type FlowExecutor runs ('sequence', 'llmCall',
// 'oneOf', 'setVariable', ...).
const steps: EditorStep = {
  type: 'sequence',
  steps: [
    { type: 'llmCall', prompt: 'Classify this message as billing, technical or sales: {{message}}', outputVariable: 'category' },
    { type: 'llmCall', prompt: 'Write a one-line reply for a {{category}} request: {{message}}' },
  ],
};

const flow = new FlowBuilder()
  .setCode('triage')
  .setName('Triage')
  .addInput({ name: 'message', type: 'shortText', required: true })
  .setFlow(steps)
  .build();

// FlowExecutor is a static API too: execute(flow, context, onEvent?)
const result = await FlowExecutor.execute(flow, { agent, provider, variables: { message: 'My invoice is wrong' } });
```

An `llmCall` step's model is its own `model`, else the agent's
`settings.model`, else the provider's default (`gpt-4o-mini` above). Either
setting is the provider's bare model id, such as `'gpt-4o'`, handed to
`provider.generate()` as is: not a `'openai/gpt-4o'` spec, which only
`resolveProvider()` and `createAgent({ model })` read. An `llmCall` returns
the reply text; it has no structured-output (schema) option. For a typed
result, parse the text in a later step, or call an agent that has a
structured output as a tool (see [Running an agent in a flow](#running-an-agent-in-a-flow)).

### Template values

A `{{name}}` placeholder in a prompt, a `throw` message or a tool argument
is replaced by the variable's text:

- A string is used as is; a number or boolean is its text (`0` is `'0'`); a
  variable that is not set, or is `null`, is `''`.
- An object whose only field is `text` (an [MCP tool](./mcp.md) result,
  `{ text }`) is that text, and so is a raw MCP result
  (`{ content: [{ type: 'text', text }] }`, its text parts joined by newlines).
- Any other object or array is its JSON, so a `toolCall` result stored in
  `outputVariable` reads `{"city":"Oslo","temp":4}` in the next prompt, not
  `[object Object]`.
- A dotted path reads into an object or array: `{{weather.city}}`,
  `{{results.0.title}}`. Only own properties are read (`{{res.constructor}}`
  is `''`), and a missing step on the path is `''`.

An `evaluator` step stores its result in `outputVariable` too, like
`llmCall` and `toolCall`.

## Node types

`FlowExecutor` runs these node types:

| `type` | What it does |
| ------ | ------------ |
| `sequence` | Runs its `steps` one after another. |
| `parallel` | Runs its steps at the same time. If one fails, the others are cancelled (see [Cancelling a flow](#cancelling-a-flow)). |
| `llmCall` | Calls the model with a `prompt` (with `{{variable}}` placeholders; see [Template values](#template-values)); `outputVariable` stores the reply text. |
| `agent` | Sends `input` (placeholders interpolated) to a `createAgent()` agent registered in the context's `agents` (see [Running an agent in a flow](#running-an-agent-in-a-flow)); `outputVariable` stores the reply text. |
| `toolCall` | Calls a tool with `arguments` (placeholders interpolated; see [Argument values](#argument-values)). |
| `setVariable` | Sets `variable` to `value`. |
| `oneOf` | Takes the first branch whose condition matches. |
| `forEach` | Runs a step for each item of `items`, one after another. The item and index (`itemVariable`, default `item`; `indexVariable`, default `index`) belong to that iteration only, so loops in `parallel` branches never see each other's item; other variables the step sets are written to the flow's variables. |
| `evaluator` | Evaluates an expression over the flow's variables; `outputVariable` stores the result. |
| `return`, `end` | Produce the node's `value` as the result. |
| `throw` | Fails the flow with the node's `message` (`{{variable}}` placeholders interpolated; default `'Flow error'`). |

`oneOf` conditions and `evaluator` expressions use a small, safe expression
language (no `eval`, no host code; `{{name}}` placeholders are bound as
values, never pasted into the expression). Its grammar and failure rules are
in [Flow expressions](#flow-expressions).

## Tool calls

A `toolCall` step passes the same checks as a tool call in an agent run before
its tool runs:

- Its arguments, after `{{variable}}` interpolation, are validated against the
  tool's input schema. Arguments that do not match fail the step with
  `LOUSHO_TOOL_ARGS_INVALID`, listing each problem, and the tool is not called.
- The flow context's `permissions`, `permissionMode` and `onPermissionDecision`
  apply as they do for `createAgent()` (see [Permission policies](./approvals.md#permission-policies) and [Permission modes](./permission-modes.md)).
- A call that needs approval (the tool's `needsApproval`, or an `ask` rule) is
  decided by the context's `approve` callback, which has the same shape as
  `createAgent({ approve })`. `true` (or a note) runs the tool. `false` refuses
  it with `LOUSHO_FLOW_TOOL_DENIED`. When `approve` returns `'defer'`, or there
  is no `approve` callback, a [durable run](#durable-runs) pauses until a person
  decides (see [Pausing for approval](#pausing-for-approval)). A run that is
  not durable refuses the call with `LOUSHO_FLOW_TOOL_DENIED`. The tool is
  never run unapproved.

```ts
import { FlowExecutor, type AgentFlow } from 'lousho/flows';

declare const flow: AgentFlow;

const result = await FlowExecutor.execute(flow, {
  agent,
  provider,
  toolRegistry,
  variables: { invoiceId: 'inv-1' },
  approve: ({ toolName, args }) => toolName !== 'pay_vendor' || Number(args.amount) < 1000,
});
```

### Argument values

An argument string that is exactly one placeholder, `'{{name}}'` or
`'$name'`, passes the variable's value as it is: a number stays a number, an
object stays an object; `'{{res.count}}'` passes that field's value. So `arguments: { n: '{{n}}' }` with `n = 5` passes
`5` to a tool whose schema is `z.number()`. This also applies inside arrays
and nested objects. Any other string is interpolated as text:
`'n is {{n}}'` becomes `'n is 5'`. A placeholder of a variable that is not
set stays as before: `'{{missing}}'` is `''`, and `'$USD'` (no variable
named `USD`) is the literal string `'$USD'`.

```ts
import type { EditorStep } from 'lousho/flows';

// With variables { count: 5, tags: ['a', 'b'] }, the tool gets { count: 5, tags: ['a', 'b'], note: 'count: 5' }.
const step: EditorStep = {
  type: 'toolCall',
  tool: 'create_batch',
  arguments: { count: '{{count}}', tags: '$tags', note: 'count: {{count}}' },
};
```

A flow's declared inputs are checked before the first step runs. A missing
`required` input, or a value of the wrong type, fails the flow with
`LOUSHO_VALIDATION_FAILED`.

## Cancelling a flow

Pass `signal` in the context to cancel a run. It is checked before every step:
once it is aborted, no further step starts and the flow fails with the signal's
`reason`. The step that is running gets the signal too: an `llmCall` passes it
to the model request, and a `toolCall` hands it to the tool as `ctx.abortSignal`.

```ts
import { FlowExecutor, type AgentFlow } from 'lousho/flows';

declare const flow: AgentFlow;

const result = await FlowExecutor.execute(flow, {
  agent,
  provider,
  variables: {},
  signal: AbortSignal.timeout(30_000),
});
```

When a branch of a `parallel` step fails, its sibling branches are cancelled
the same way: they start no further step, and their running `llmCall` or
`toolCall` gets an aborted signal. The flow returns the first branch's error
only once every branch has settled, so no tool runs and no event is added to
`result.events` after the result is returned. A tool that ignores
`ctx.abortSignal` still runs to the end, and the flow waits for it.

`result.usage` sums the model usage (`promptTokens`, `completionTokens`,
`totalTokens`, and `cachedInputTokens`, `reasoningTokens`, `costUsd` when
reported) of every `llmCall` in the run, including a failed one.

A step without an `id` gets one that is unique within the run (`step-1`,
`step-2`, ... in the order the steps start), so `step-start` and
`step-complete` events can be paired by `stepId`.

## Retries and time limits

Any node can have `retry` and `timeoutMs`. That includes `llmCall`,
`toolCall`, `sequence`, `parallel` and `forEach`.

- `retry: { maxAttempts, backoffMs? }` runs a failing node again, up to
  `maxAttempts` attempts in all. It waits `backoffMs * 2^(attempt - 1)` ms
  before each retry (default `0`). Each failed attempt that is retried emits a
  `step-retry` event with `{ attempt, maxAttempts, delayMs }` and the
  attempt's `error`. Only the last failure emits `step-error`. A cancelled run
  (`signal`) is not retried, and neither is a model failure that retrying
  cannot fix (see below).
- `timeoutMs` fails an attempt that runs longer with `LOUSHO_OPERATION_TIMEOUT`
  (a `TimeoutError`). The attempt's model request or tool call gets an aborted
  signal. A timed-out attempt is retried like any other failure. A tool that
  ignores `ctx.abortSignal` keeps running in the background.

An `llmCall` whose model request fails fails with the same
`CompactedLLMProviderError` an agent run rejects with, not the provider SDK's
raw error: `code` is `LOUSHO_PROVIDER_RATE_LIMITED` for a 429 and
`LOUSHO_PROVIDER_REQUEST_FAILED` otherwise, and `compacted` holds
`{ error, category, retryable, statusCode?, providerName? }`. A failure with
`retryable: false` (an `'auth-failure'` such as a 401 or a bad API key, a
`'quota-exceeded'`, a `'context-length-exceeded'`) fails the step at once,
without using its remaining `retry` attempts; a rate limit, a timeout or a 5xx
is retried.

Invalid values (`maxAttempts` < 1 or not an integer, a negative `backoffMs`,
a `timeoutMs` <= 0) fail the step with `LOUSHO_FLOW_INVALID`.

```ts
import type { EditorStep } from 'lousho/flows';

const fetchInvoice: EditorStep = {
  type: 'toolCall',
  tool: 'fetch_invoice',
  arguments: { id: '{{invoiceId}}' },
  outputVariable: 'invoice',
  retry: { maxAttempts: 3, backoffMs: 500 },
  timeoutMs: 10_000,
};
```

A retried container runs its children again. The exception is a durable run
(below): there, children that completed in an earlier attempt are skipped.

## Durable runs

Pass a `checkpointStore` and a `runId` to make a run durable. The run's
variables, the nodes that completed (with their results), the branch each
`oneOf` took and the usage so far are saved under `runId` after every node
that completes, and again when the flow finishes. A new run is also saved
once before its first step (after its inputs are checked), so a run whose
first step fails can be resumed too. Any `CheckpointStore` works,
such as `memoryStore().checkpoints` or a SQLite store (see
[Durable execution](./durable-execution.md)).

After a crash, or when a step failed, continue the run with
`FlowExecutor.resume(flow, context)`. Pass the same `checkpointStore` and
`runId`. Completed nodes are not run again: each one returns its saved result,
and a `oneOf` takes the branch it took before. Everything else runs as usual,
from the saved variables. `result.usage` and `result.steps` include the
earlier attempts.

```ts
import { FlowExecutor, type AgentFlow } from 'lousho/flows';
import { memoryStore } from 'lousho';

declare const flow: AgentFlow;
const checkpointStore = memoryStore().checkpoints;

const first = await FlowExecutor.execute(flow, { agent, provider, toolRegistry, variables: { orderId: 'o-42' }, checkpointStore, runId: 'order-o-42' });
if (!first.success) {
  // Fix the cause, then continue where it stopped.
  const result = await FlowExecutor.resume(flow, { agent, provider, toolRegistry, checkpointStore, runId: 'order-o-42' });
}
```

- A node is identified by its place in the flow, not its `id`. Resume a run
  with the flow that started it. A resume with a flow of another `code` is
  refused with `LOUSHO_CONFIG_INVALID`. The run also saves its flow's
  structure (each node's type, `id`, tool or agent, and their order); a resume
  with the same `code` whose steps were added, removed or moved is refused with
  `LOUSHO_FLOW_CHANGED`, since the saved results would land on the wrong steps.
  Editing a prompt, condition or other setting keeps the structure. Runs saved
  before this check resume without it.
- Resuming a finished run returns its saved result with no events, and runs
  nothing. `execute()` with the `runId` of a finished run starts a new run.
  `execute()` with the `runId` of an unfinished run is refused with
  `LOUSHO_CONFIG_INVALID`; resume it instead, or use a new `runId`.
- A run with no checkpoint is refused with `LOUSHO_CHECKPOINT_NOT_FOUND`. A
  run whose declared inputs were invalid saved none: call `execute()` again
  with valid inputs.
- Only one call runs a `runId` at a time. While `execute()` or `resume()`
  runs, it holds a run lease on the `runId` in the store, the same lease an
  agent run takes (see [Durable execution](./durable-execution.md)). Another
  `execute()` or `resume()` of that `runId` is refused with
  `LOUSHO_SESSION_BUSY`, and runs nothing. That holds in this process, in
  another process or replica on the same store, and through another store
  object over the same data. The lease is renewed while a long step runs, and
  released when the call returns. If the process holding it died, the lease
  expires (in 60 s at most), and then the run can be resumed. A custom
  `CheckpointStore` without `acquireLease` runs without leases.
- A node that completed is only skipped once its checkpoint was saved, and
  its `step-complete` event is emitted after that save, so a step reported
  complete is never run again on resume. A node
  interrupted while running (an `llmCall` or a `toolCall`) runs again, so make
  side-effecting tools idempotent.
- Variables and node results must survive `structuredClone`, so no functions
  and no class instances.
- The item and index of a `forEach` iteration are not saved. An interrupted
  iteration runs again with its item. Completed iterations are skipped.

`result.status` is `'completed'`, `'failed'`, or `'awaiting-approval'` (see
below).

### Pausing for approval

In a durable run, a `toolCall` that needs approval pauses the flow when
`approve` returns `'defer'` or there is no `approve` callback. The tool is not
run. The run is saved with status `'awaiting-approval'`, and `execute()` (or
`resume()`) returns:

- `status: 'awaiting-approval'` and `success: false`, with no `error`
- `approvalId`: the id to decide
- `pendingApproval`: `{ approvalId, nodeId, toolName, args }`, the call waiting
  for the decision

A pause is not a failure, so it emits no `step-error` or `flow-error` and is
not retried. If the paused step is in a `parallel` node, its sibling branches
are cancelled. Steps they completed are kept, and the rest run again on resume.

To continue, pass the decision to `resume()`:

```ts
import { FlowExecutor, type AgentFlow } from 'lousho/flows';
import { memoryStore } from 'lousho';

declare const flow: AgentFlow;
const checkpointStore = memoryStore().checkpoints;

const paused = await FlowExecutor.execute(flow, {
  agent, provider, toolRegistry, variables: { amount: '900.00' }, checkpointStore, runId: 'payout-7',
  approve: ({ args }) => (Number(args.amount) < 100 ? true : 'defer'),
});
if (paused.status === 'awaiting-approval') {
  // later, once a person decided (in another process too):
  const result = await FlowExecutor.resume(flow, {
    agent, provider, toolRegistry, checkpointStore, runId: 'payout-7',
    approval: { approvalId: paused.approvalId!, approved: true },
  });
}
```

What each decision does:

- **Approved:** the paused step runs its tool with the saved arguments, and
  `approve` is not asked again.
- **Rejected:** the step fails with `LOUSHO_FLOW_TOOL_DENIED`, like `approve`
  returning `false`.
- **Used once:** after one resume, the run no longer waits for that approval.
  A later resume runs the step again, so it needs a new decision.

These resume calls are refused:

- A resume of a paused run without `approval`: `LOUSHO_SESSION_AWAITING_APPROVAL`.
- A resume with another `approvalId`, or with an approval for a run that is
  not paused: `LOUSHO_APPROVAL_NOT_FOUND`.

Flow approvals are not listed in an agent's approval store. Keep the
`approvalId` (or read `checkpoint.flow.pendingApproval` from the store) to
decide later.

## Running an agent in a flow

An `agent` step calls a `createAgent()` agent registered in the context's
`agents` map, by name. The agent runs its own loop — its model, tools,
guardrails and approvals — and the step stores its reply text:

```ts
import { createAgent } from 'lousho';
import { FlowExecutor, type AgentFlow } from 'lousho/flows';

const writer = createAgent({ name: 'writer', model: 'openai/gpt-4o-mini', instructions: 'Draft a reply.' });

const flow: AgentFlow = {
  code: 'support',
  name: 'Support',
  flow: {
    type: 'sequence',
    steps: [
      { type: 'agent', agent: 'writer', input: 'Write about {{topic}}', outputVariable: 'draft' },
      { type: 'llmCall', prompt: 'Polish this draft: {{draft}}' },
    ],
  },
};

const result = await FlowExecutor.execute(flow, { agent, provider, variables: { topic: 'WebAssembly' }, agents: { writer } });
```

- `input` is the message sent to the agent; `{{variable}}` placeholders are
  replaced (default `'{{input}}'`, the flow's `input` variable).
- An `agent` step emits `llm-call` and `llm-response` events carrying
  `data.agent` (not `data.model`), and takes `retry` and `timeoutMs` like
  any other step. Its reply is stored as text; the agent's usage is in its
  `send()` result, not the flow's `result.usage`.
- A step naming an agent that is not in `agents` fails with
  `LOUSHO_FLOW_INVALID`, naming the keys that are registered.
- An agent whose run pauses for an approval (a `needsApproval` tool with no
  approver) fails the step with `LOUSHO_FLOW_EXECUTION_FAILED`: agent steps
  cannot pause a flow. Decide the agent's tools with permissions or an
  `approve` callback on the agent.
- Traced, the agent's `invoke_agent` span nests under the step's
  `flow.node agent` span.

A flow's other steps still run under the plain `agent` config in the
context (`{ name, prompt?, settings }`); passing a `createAgent()` agent as
`context.agent` is refused with `LOUSHO_CONFIG_INVALID`.

Instead of an `agent` step, you can register a tool that calls
`agent.send()` and call it in a `toolCall` step — the call then goes
through the flow's permission and approval gates, and its result can be a
typed value rather than text:

```ts
import { z } from 'zod';
import { createAgent } from 'lousho';
import { FlowExecutor, type AgentFlow } from 'lousho/flows';
import { ToolRegistry } from 'lousho/tools';

const researcher = createAgent({ name: 'researcher', model: 'openai/gpt-4o-mini', instructions: 'Answer with three facts.' });

const toolRegistry = new ToolRegistry();
toolRegistry.register('research', {
  displayName: 'Research',
  tool: {
    description: 'Asks the researcher agent a question',
    parameters: z.object({ question: z.string() }),
    execute: async ({ question }: { question: string }) => (await researcher.send(question)).text,
  },
});

const flow: AgentFlow = {
  code: 'report',
  name: 'Report',
  flow: { type: 'toolCall', tool: 'research', arguments: { question: 'What is {{topic}}?' }, outputVariable: 'facts' },
};
const result = await FlowExecutor.execute(flow, { agent: { name: 'report' }, provider, toolRegistry, variables: { topic: 'WebAssembly' } });
```

For a single model call with no tools, an `llmCall` step is simpler.

The `step` node type (`StepNode`, `{ type: 'step', agent, input }`) is a
shape that visual editors produce. `FlowExecutor` does not run it: a flow
that reaches one fails with `LOUSHO_FLOW_INVALID` — use an `agent` step.

## Flows, sub-agents or skills?

Use a flow when the pipeline is known in advance; use
[sub-agents](./sub-agents.md) when the model should decide what to delegate,
and [skills](./skills.md) when the same agent just needs extra instructions for
some tasks. See [Sub-agents, skills or flows?](./sub-agents.md#sub-agents-skills-or-flows).

Flows are traced like agent runs (see
[Tracing and observability](./observability.md#flows)).

## Flow expressions

`oneOf` branch conditions (and the Agent Forge router node's branch conditions)
and `evaluator` node expressions are evaluated by a small built-in expression
evaluator. It never compiles or runs host code: there is no `eval`,
`new Function` or `vm` in `src/flows`. `{{name}}` placeholders are bound as
values, never pasted into the expression text: a bare `{{score}} >= 90` uses the
variable's value, and inside a string literal, `'{{classify}}' === 'refund'`
interpolates the value's text into that literal after the expression has been
tokenized. A variable whose value contains quotes, backslashes or operators
(for example `x' === 'x' || 'a`) is therefore just data and cannot change the
condition's logic. A missing or `null` variable is an empty string inside a
literal; used bare it contributes nothing, so `{{missing}} >= 90` is a syntax
error and the condition counts as not matched. The expression is evaluated
against the flow's variables.

| Form | Examples |
| --- | --- |
| Literals | `'text'`, `"text"`, `42`, `1.5`, `true`, `false`, `null` |
| Variables and paths | `score`, `user.address.city`, `user['first-name']`, `items[0].id` |
| Length | `name.length`, `items.length` (strings and arrays) |
| Comparison | `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=` |
| Logical | `&&`, `\|\|`, `!` (short-circuiting, return the deciding operand) |
| Arithmetic | `+`, `-`, `*`, `/`, `%`, unary `-` and `+` |
| Grouping | `( ... )` |
| Allow-listed methods | `s.includes(x)`, `s.startsWith(x)`, `s.endsWith(x)` on strings; `list.includes(x)` on arrays (exactly one argument) |

Precedence, loosest to tightest: `||`, `&&`, equality, relational, `+ -`,
`* / %`, unary, member access.

Not supported, and rejected with an `ExpressionError` that names the
expression, the character position and this list of supported forms: any other
function or method call, assignment (`=`, `+=`, `++`), ternaries, template
strings, object/array literals, access to `constructor`, `__proto__` or
`prototype`, and globals (`process`, `require`, `globalThis`, ...). Only a
flow's own variables, and only their own properties, are reachable.

Failure behaviour is unchanged: a `oneOf` condition that cannot be evaluated
counts as not matched (`false`), and an `evaluator` expression that cannot be
evaluated fails the flow with `Failed to evaluate expression: ...`, including
the `ExpressionError` detail.
