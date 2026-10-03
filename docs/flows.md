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
| `throw` | Fails the flow with the node's `message` (`{{variable}}` placeholders interpolated; default `'Flow error'`). |

`oneOf` conditions and `evaluator` expressions use a small, safe expression
language (no `eval`, no host code; `{{name}}` placeholders are bound as
values, never pasted into the expression). Its grammar and failure rules are
in [Flow expressions](#flow-expressions).

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
