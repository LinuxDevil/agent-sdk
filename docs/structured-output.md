# Structured output

Give an agent a zod schema as `output` and its final reply becomes a typed,
validated object: `result.object`. The agent can still call tools first; only
the final answer has to match the schema. The `vendor/` model prefix chooses
the provider; with OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You report the weather.',
  output: z.object({ city: z.string(), tempC: z.number(), summary: z.string() }),
});

const result = await agent.send('Weather in Paris?');
if (result.object) {
  console.log(result.object.tempC); // typed: number
} else {
  console.error(result.finishReason, result.outputError?.issues); // 'output-invalid', [{ path, message }]
}
```

`result.object` is typed as `z.output<typeof schema>`, so zod defaults and
transforms apply. `result.text` keeps the raw JSON text the model wrote.

The schema can come from zod 3 or zod 4: it is rendered with `z.toJSONSchema`
for zod 4 and with the `ai` SDK's converter for zod 3, and validated with the
schema's own `safeParse` either way. `output` is typed as a Standard Schema,
the same as `defineTool({ input })`, so `result.object` is inferred without a
cast from a zod 3 schema, a zod 4 schema (`zod/v4` on zod 3.25, or zod 4
itself) or any other Standard Schema that can produce JSON Schema:

```ts
import { z } from 'zod/v4';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string() }) });
const { object } = await agent.send('Where is the Eiffel Tower?');
console.log(object?.city); // typed: string
```

## Sessions

`agent.session()` on an agent with `output` returns a session whose
`send()` result (and `stream()`'s `result`) carries the typed `object` of each
turn. There is no per-call `output` override: the schema is the agent's.

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string(), tempC: z.number() }) });
const session = agent.session();
const { object } = await session.send('Weather in Paris?');
console.log(object?.tempC); // typed: number
```

## Sub-agents

A sub-agent created with its own `output` schema answers the lead with its
validated object. The `task` tool result (and `agent_await`'s `result` for a
background task) is the object as JSON, then a blank line and the usual
`[sub-agent '<name>': ... taskId '<id>']` footer, so the lead model sees the
object rather than a prose rendering. If the sub-agent's reply is still invalid
after its repair step, the `task` call fails with the structured tool error
(`kind: 'execution'`, a message naming the schema issues) and the lead can
retry or adapt.

A sub-agent does **not** inherit the lead's `output`: each agent's output is its
own, and a sub-agent without `output` returns text as before. A
[`remoteAgent()`](./sub-agents.md#remote-sub-agents) whose deployed agent has an
`output` schema returns the remote object the same way (JSON, then its footer),
read from the `object` of the remote stream's `run.done` event.

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const reporter = createAgent({
  model: 'openai/gpt-4o-mini',
  description: 'Reports the weather as { city, tempC }',
  output: z.object({ city: z.string(), tempC: z.number() }),
});
const lead = createAgent({ model: 'openai/gpt-4o-mini', subagents: { reporter } });
const result = await lead.send('What is the weather in Paris?');
console.log(result.text);
```

## Optional fields

Optional fields work on strict structured-output endpoints (OpenAI,
OpenRouter), which require every property to be listed in `required`. In the
JSON Schema sent to the model, each optional property (`.optional()`,
`.default()`) is required and nullable instead, at every level: nested
objects, array items and union branches. A `null` the model returns for such a
field is removed before validation, so the schema you wrote still validates it
and `result.object` has no key for it. A field that accepts `null` itself
(`.nullable()`, `.nullish()`) keeps the `null`.

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openrouter/openai/gpt-4o-mini',
  output: z.object({ verdict: z.string(), note: z.string().optional() }),
});
const { object } = await agent.send('Review this change.');
// The model may answer {"verdict":"approve","note":null}; object is { verdict: 'approve' }.
console.log(object?.note); // typed: string | undefined
```

## How it works

1. The system prompt gets an `## Output format` section asking for the final
   answer as only a JSON object matching the schema, rendered as JSON Schema.
2. Every model call carries `responseFormat: { type: 'json', schema }` on
   `GenerateOptions`. It is a hint: the built-in `ai`-SDK providers turn on
   the model's JSON mode (with the schema, for models that support structured
   outputs); a custom provider may use it or ignore it.
3. When the model replies without tool calls, the reply is parsed as JSON (a
   ```` ```json ```` code fence around it is tolerated) and validated with
   the schema. A near miss is read without a repair call: when the whole
   reply is not JSON, `<think>…</think>` blocks are removed and the first
   fenced block, or balanced `{…}` / `[…]`, that parses and validates is
   used. So a prose prefix, trailing prose after a fenced block, or a
   reasoning block before the JSON costs nothing extra. `result.text` keeps
   the reply as the model wrote it.
4. If it is invalid, the model gets one repair step: a user message
   starting with `[output-invalid]` that lists the issues, for example
   `1 issue (tempC: Expected number, received string)`. When the reply was
   the JSON Schema itself (some local models echo it), the message says so
   and shows an example object of the right shape instead. The repair step
   counts against `maxSteps`, and there is none when the budget is spent.
5. Still invalid, the run resolves (it does not reject) with
   `finishReason: 'output-invalid'`, no `object`, and `outputError`:
   `{ message, issues: [{ path, message }] }`.

## The schema in the prompt

Steps 1 and 2 send the schema twice: once inside the `## Output format`
system-prompt block, and once on `responseFormat`. When the provider enforces
`responseFormat` (OpenAI structured outputs, OpenRouter, the `pi` provider)
the prompt copy is redundant - on a large schema it costs around a thousand
tokens per call. Pass `output` as `{ schema, promptSchema: false }` to leave
the schema out of the prompt; the JSON-only ask stays and `responseFormat` is
sent unchanged:

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o',
  output: { schema: z.object({ city: z.string(), tempC: z.number() }), promptSchema: false },
});
const { object } = await agent.send('Weather in Paris?');
```

Keep the default (`promptSchema: true`, or a bare `output: schema`) when the
provider - or model - treats `responseFormat` as a JSON-mode hint only (the
built-in `ai`-SDK providers drop the schema for models without
structured-outputs support; a custom provider may ignore it entirely). The
prompt copy is then the only place the model sees the shape to answer with.

## Repaired output and business rules

When `object` came from the repair step, the result has
`outputRepaired: true`. A repair answers the issues it is shown, so it can
**change values** to make them validate. If the schema encodes a business
rule, such as a refinement that `total` equals `subtotal + tax`, a model
asked to repair an invoice whose printed total breaks the rule may rewrite
the total so the object passes. Keep the schema to the document's
structure, and check business rules on `result.object` after extraction,
where a failure is yours to report:

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const Invoice = z.object({ subtotal: z.number(), tax: z.number(), total: z.number() });
const agent = createAgent({ model: 'openai/gpt-4o-mini', output: Invoice });

const result = await agent.send('Extract the invoice: subtotal 100.00, tax 19.00, total 120.00');
const invoice = result.object;
if (invoice && Math.abs(invoice.subtotal + invoice.tax - invoice.total) > 0.005) {
  console.warn('Totals do not add up', invoice, result.outputRepaired ? '(after a repair)' : '');
}
```

## Schema limits

- **The root must be an object.** A root-level union of objects
  (`z.union`, `z.discriminatedUnion`) is sent with `type: 'object'` next to
  its `anyOf`. A root union with a branch that is not an object throws a
  `ConfigurationError` from `createAgent()`: wrap it, as in
  `z.object({ result: z.union([...]) })`.
- **No `z.date()`.** JSON has no date type, so a zod 4 `z.date()` field could
  never validate. `createAgent()` throws a `ConfigurationError` naming the
  field. Use `z.iso.date()` or `z.iso.datetime()` for an ISO string, or
  `z.iso.datetime().pipe(z.coerce.date())` for a `Date` in `result.object`.

## Streaming

`agent.stream()` works the same way: `run.result` resolves with `object`,
and the final `run.done` event carries `object` (JSON-encoded) when the
reply was valid. The repair step shows up as one more
`step.start` / `step.done` pair. See [Streaming](./streaming.md).

## Advanced: the executor API

`AgentExecutor.execute()` and `AgentExecutor.stream()` take the same
`output` option. There `result.object` is `unknown`; parse it again with your
schema, or use `createAgent()` for the inferred type.

```ts
import { z } from 'zod';
import { AgentBuilder, AgentExecutor } from '@lousho/build-ai-agent/executor';
import { createMockProvider } from '@lousho/build-ai-agent';

const Ticket = z.object({ title: z.string(), priority: z.enum(['low', 'high']) });
const agent = AgentBuilder.create().setName('triage').setPrompt('You triage bug reports.').build();
const result = await AgentExecutor.execute({ agent, input: 'The app crashes on login', provider: createMockProvider(), output: Ticket });
const ticket = result.object === undefined ? undefined : Ticket.parse(result.object);
```

## Testing

With `mockModel`, script the JSON text the model would write:

```ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel(['{"city":"Paris","tempC":21}']), output: z.object({ city: z.string(), tempC: z.number() }) });
const { object } = await agent.send('Weather in Paris?');
console.log(object?.city); // 'Paris'
```

## See also

- [Decisions](./decisions.md): `decide()` answers predicate / choice / score questions over one input on a dedicated fast endpoint — the right call when you need a classification or confidence, not an object.
