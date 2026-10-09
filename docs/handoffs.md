# Handoffs

A handoff passes the whole conversation to another agent. A triage agent reads
the user's request and hands it to a specialist; the specialist answers the
user directly, and in a session it keeps the conversation in later turns.

## Handoffs or sub-agents?

| Use | What happens |
| --- | --- |
| **Handoffs** | The target takes over. It sees the conversation (or what an `inputFilter` keeps), answers the user itself, and stays the active agent of the session until it hands on or back. The agent that handed off does not see the answer. |
| **[Sub-agents](./sub-agents.md)** | The lead stays in charge. A sub-agent sees only the task prompt the lead wrote, does the work, and returns a result to the lead, which then answers the user. |

## Quick start

Give each target a `name` and a `description` (the model reads the
description to decide when to hand off), then pass them to the triage agent as
`handoffs`. The `vendor/` model prefix chooses the provider; with OpenRouter
use `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const lookupCharges = defineTool({
  name: 'lookup_charges',
  description: "Lists the user's recent charges",
  input: z.object({}),
  execute: async () => [{ date: '2026-09-01', amountUsd: 9.99 }],
});

const billing = createAgent({
  name: 'billing',
  description: 'Handles charges, refunds and subscriptions',
  instructions: 'You are the billing desk. Answer in one or two sentences.',
  model: 'openai/gpt-4o-mini',
  tools: [lookupCharges],
});

const techSupport = createAgent({
  name: 'tech-support',
  description: 'Handles logins, passwords and technical problems',
  instructions: 'You are tech support. Answer in one or two sentences.',
  model: 'openai/gpt-4o-mini',
});

const triage = createAgent({
  name: 'triage',
  instructions: 'Route the user: billing questions to billing, technical questions to tech-support.',
  model: 'openai/gpt-4o-mini',
  handoffs: [billing, techSupport],
});

const result = await triage.send('I was charged twice for my subscription.');
console.log(result.agentName, result.text); // 'billing', the billing desk's answer
```

Each target is offered to the model as one tool, `transfer_to_<name>`
(`transfer_to_billing`, `transfer_to_tech-support`). When the model calls it,
the run goes on as the target in the same `send()` / `stream()` call.
`result.agentName` names the agent that produced the final reply.

A target must come from `createAgent()` and have a `name` (unique among the
handoffs) and a `description` (or a `description` on `handoff()`); otherwise
`createAgent()` throws `LOUSHO_CONFIG_INVALID`. A handoff tool may not share a
name with one of the agent's tools.

## `handoff()` options

Wrap a target in `handoff()` to configure it:

```ts
import { createAgent, handoff, handoffFilters } from '@lousho/build-ai-agent';
import { z } from 'zod';

const refunds = createAgent({ name: 'refunds', description: 'Issues refunds', model: 'openai/gpt-4o-mini' });

const triage = createAgent({
  name: 'triage',
  model: 'openai/gpt-4o-mini',
  handoffs: [
    handoff(refunds, {
      toolName: 'escalate_refund',
      description: 'Hand off when the user asks for money back',
      input: z.object({ orderId: z.string() }),
      inputFilter: handoffFilters.removeToolCalls,
      onHandoff: ({ from, to, args }) => console.log(`${from} -> ${to}`, args),
      isEnabled: ({ metadata }) => metadata?.plan === 'pro',
    }),
  ],
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `toolName` | `transfer_to_<name>` | The tool the model calls. |
| `description` | the target's `description` | The tool's description. |
| `input` | `{ reason?: string }` | The arguments the model passes (a zod schema or any Standard Schema). Arguments that do not match give the model a tool error, and no handoff happens. |
| `inputFilter` | everything | What the target sees (see [Input filters](#input-filters)). |
| `onHandoff` | none | Called with `{ messages, from, to, args, sessionId }` once the handoff is decided, before the target's first model call. |
| `isEnabled` | `true` | Whether the handoff is offered; a function gets the run's `{ input, metadata, principal, sessionId }`. A disabled handoff's tool is not sent to the model. |

## Input filters

The target sees the conversation as `inputFilter` returns it, under its own
system prompt (the system prompt of the agent that handed off is replaced,
never kept). The filter gets `{ messages, from, to, args }`; `messages` is the
transcript so far without the system prompt, ending with the handoff call, its
result, and a **routing note**: a system message the run appends so the target
reads who was transferred and the validated `args`
(`[routing note - not from the user] handoff triage -> billing: reason="..."`).
It is marked with `metadata.handoff`, so a filter can recognise it - drop it or
replace it to shape the target's context yourself. The note stays where it is
in the transcript, but no model request carries a system message after the
conversation has started: each request appends such messages, in order, to its
leading system prompt. The chat templates of Qwen, Llama and Mistral models (LM
Studio, llama.cpp, vLLM, Ollama) and Anthropic's API reject a system message in
the middle of a conversation. Two filters are built in:

- `handoffFilters.removeToolCalls`: keeps user and assistant text (and the
  routing note), drops tool calls and tool results.
- `handoffFilters.lastUserMessage`: keeps only the last user message.

```ts
import { handoffFilters, type HandoffInputData } from '@lousho/build-ai-agent';

// The last four messages, without tool traffic.
const recent = (data: HandoffInputData) => handoffFilters.removeToolCalls(data).slice(-4);
```

What the filter returns becomes the run's transcript: `result.messages` and a
session's history continue from it. A filter must keep at least one message.
Approvals remembered with `once()` in the earlier part of the transcript are
dropped at a handoff, so a target's tools ask again.

## What switches and what stays

| At a handoff, the target's own | The run's, for its whole length |
| --- | --- |
| instructions (system prompt), model and provider | `hooks`, `limits` and the spend so far (one budget) |
| tools, hosted tools, skills and sub-agents | `maxSteps`, counted across agents |
| `reasoning`, `modelSettings` and `toolSearch` (its own deferred tools, searched with its own tuning) | the abort signal and `toolConcurrency` |
| its own `handoffs` | the approval, checkpoint and token stores |
| guardrails and permission rules: the lead's first, then the target's own | `onEvent` and `exporter` |
| | `output`: the result is typed by the lead's schema (a target's own `output` is not used) |
| | the permission mode and the principal (who the run acts for) |
| | the approval configuration: `approve`, `approvalStore`, `approvalTtlMs`, `onPermissionDecision` |
| | the lead's [memory](./memory.md) slots, bound to the run's scope keys |

The agent the run started with is the lead. A target gets none of the lead's
tools or sub-agents, but it keeps the lead's [memory](./memory.md): the recalled
`<memory>` blocks are put back into the target's system prompt, and the
`remember_<name>` / `recall_<name>` tools are still offered, bound to the same
scope keys (the same customer, user or session). This holds in the handoff run
and in every later session turn the target runs. A target's own memory slots
are not used; give the slots to the agent runs start with. The lead's `output`
instruction is added to every target's system prompt.

Because approvals and memory are run-level, options like `approve`, `approvalStore`,
`permissionMode`, `approvalTtlMs`, `store` or `memory` on a target agent are never
consulted after a handoff - `createAgent()` warns once (per target) when a
reachable target was created with them; set them on the agent runs start with.

## Sessions

In a session the active agent is the one the transcript last handed off to
(the `to` of the last `metadata.handoff` marker), so the next
`session.send()` / `session.stream()` runs that agent:

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const billing = createAgent({ name: 'billing', description: 'Handles charges and refunds', model: 'openai/gpt-4o-mini' });
const triage = createAgent({ name: 'triage', model: 'openai/gpt-4o-mini', handoffs: [billing] });

const session = triage.session();
await session.send('I was charged twice.'); // triage hands off; billing answers
const next = await session.send('Can you refund one?'); // billing answers again
console.log(next.agentName); // 'billing'
```

`agent.send()` without a session always starts at the lead.

A target hands back with its own `handoffs`. Since the lead is created after
its targets, give the target an array and add the lead to it afterwards (the
array is read at every run):

```ts
import { createAgent, handoff, type Handoff } from '@lousho/build-ai-agent';

const billingHandoffs: Handoff[] = [];
const billing = createAgent({
  name: 'billing',
  description: 'Handles charges and refunds',
  instructions: 'For anything that is not about billing, hand back to triage.',
  model: 'openai/gpt-4o-mini',
  handoffs: billingHandoffs,
});
const triage = createAgent({
  name: 'triage',
  description: 'Routes the user to the right desk',
  model: 'openai/gpt-4o-mini',
  handoffs: [billing],
});
billingHandoffs.push(handoff(triage));
```

Names identify agents: every agent reachable through `handoffs` must have its
own name. If the agent a transcript names is no longer reachable, the lead runs.

## Approvals and resuming after a handoff

A target's tool that needs approval pauses the run in the lead's approval
store; `agent.approvals.resolve()` on the lead continues it as the target. A
checkpointed run (`send(message, { sessionId })` or a session with a store)
that crashed after a handoff resumes as the target with `agent.resume(id)` or
`session.resume()`. The drift check on resume (`onAgentDrift`, see
[Durable execution](./durable-execution.md#resuming-with-a-changed-agent))
compares with the target's saved fingerprint.

When a step has a handoff call next to a call that pauses for approval, the
handoff waits: the run pauses as the agent that handed off, and the handoff
happens once the approval is decided and the step's other calls ran.

The `transfer_to_*` call itself passes the same gate as a tool call:
`permissions` rules apply to it (`deny` gives the model a `kind: 'denied'`
tool error and no handoff happens; `ask` pauses the run for approval and the
decided call then hands off or reports the rejection), `preToolCall` hooks may
deny it or rewrite its arguments (the routing note and the target see the
rewritten input), and the decision is audited to `onPermissionDecision` /
`permission.decision` like any tool call.

## Events

A handoff is reported between the handoff call's `tool.start` / `tool.done`
and the target's first `step.start`:

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const billing = createAgent({ name: 'billing', description: 'Handles charges and refunds', model: 'openai/gpt-4o-mini' });
const triage = createAgent({ name: 'triage', model: 'openai/gpt-4o-mini', handoffs: [billing] });

for await (const event of triage.stream('I was charged twice.')) {
  if (event.type === 'handoff') console.log(`${event.from} -> ${event.to}`); // triage -> billing
}
```

`handoff` carries `from`, `to` and `toolCallId`. A run has one `run.start`
and one `run.done` however many handoffs it makes. See the
[event schema](./stream-events.md).

## Limits

- Only one handoff per model turn: when a turn calls several handoff tools,
  the first is honored and the others get a tool error.
- `maxHandoffs` (a `createAgent()` option, default 5) caps the handoffs of one
  run, to stop agents handing a conversation back and forth. A handoff call
  over it gets a tool error and the agent answers itself. A run resumed after
  an approval or a crash counts again from zero.
- Remote agents (`remoteAgent()`) cannot be handoff targets; use them as
  sub-agents.
- A target does not hand back on its own at the end of its turn; give it a
  handoff to the lead (see [Sessions](#sessions)).

## The executor API

`AgentExecutor.execute()` takes `handoffs` (`ResolvedHandoff[]`: `name`,
`toolName`, `description`, `input`, `spec(input)` resolving the target's run
configuration and its own handoffs, `inputFilter`, `onHandoff`) and
`maxHandoffs`. `createAgent()` builds them; pass them yourself only when you
drive the executor directly.
