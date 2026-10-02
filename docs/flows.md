# Flows

A flow is a fixed, multi-step workflow run by one agent: the steps and their
order are written down up front instead of being left to the model's judgment.
Describe the graph with `FlowBuilder` and run it with the static
`FlowExecutor.execute(flow, context, onEvent?)`.

```ts
import { FlowBuilder, FlowExecutor, type EditorStep } from '@lousho/build-ai-agent';

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
const result = await FlowExecutor.execute(flow, { agent, provider, variables: { message: input } });
```

## Node types

`FlowExecutor` runs these node types:

| `type` | What it does |
| ------ | ------------ |
| `sequence` | Runs its `steps` one after another. |
| `parallel` | Runs its steps at the same time. |
| `llmCall` | Calls the model with a `prompt` (with `{{variable}}` placeholders); `outputVariable` stores the reply. |
| `toolCall` | Calls a tool with `arguments` (placeholders interpolated). |
| `setVariable` | Sets `variable` to `value`. |
| `oneOf` | Takes the first branch whose condition matches. |
| `forEach` | Runs a step for each item of `items`, one after another. |
| `evaluator` | Evaluates an expression over the flow's variables. |
| `return`, `end` | Produce the node's `value` as the result. |

`oneOf` conditions and `evaluator` expressions use a small, safe expression
language (no `eval`, no host code; `{{name}}` placeholders are bound as
values, never pasted into the expression). Its grammar and failure rules are
in [Flow expressions](./api-overview.md#flow-expressions).

## Flows, sub-agents or skills?

Use a flow when the pipeline is known in advance; use
[sub-agents](./sub-agents.md) when the model should decide what to delegate,
and [skills](./skills.md) when the same agent just needs extra instructions for
some tasks. See [Sub-agents, skills or flows?](./sub-agents.md#sub-agents-skills-or-flows).

Flows are traced like agent runs (see
[Tracing and observability](./observability.md#flows)).
