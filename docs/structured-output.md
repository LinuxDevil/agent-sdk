# Structured output

Give an agent a zod schema as `output` and its final reply becomes a typed,
validated object: `result.object`. The agent can still call tools first; only
the final answer has to match the schema.

```ts
import { z } from 'zod';
import { createAgent } from '@loushy/build-ai-agent';

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
schema's own `safeParse` either way. The `output` option is typed with the
installed `zod`'s `ZodType`, so a schema from the other major (`zod/v4` on zod
3.25, `zod/v3` on zod 4) runs but needs a cast until that type is widened.

## How it works

1. The system prompt gets an `## Output format` section asking for the final
   answer as only a JSON object matching the schema, rendered as JSON Schema.
2. Every model call carries `responseFormat: { type: 'json', schema }` on
   `GenerateOptions`. It is a hint: the built-in `ai`-SDK providers turn on
   the model's JSON mode (with the schema, for models that support structured
   outputs); a custom provider may use it or ignore it.
3. When the model replies without tool calls, the reply is parsed as JSON (a
   ```` ```json ```` code fence around it is tolerated) and validated with
   the schema.
4. If it is invalid, the model gets one repair step: a user message
   starting with `[output-invalid]` that lists the issues, for example
   `1 issue (tempC: Expected number, received string)`. The repair step
   counts against `maxSteps`, and there is none when the budget is spent.
5. Still invalid, the run resolves (it does not reject) with
   `finishReason: 'output-invalid'`, no `object`, and `outputError`:
   `{ message, issues: [{ path, message }] }`.

## Streaming

`agent.stream()` works the same way: `run.result` resolves with `object`,
and the final `run.done` event carries `object` (JSON-encoded) when the
reply was valid. The repair step shows up as one more
`step.start` / `step.done` pair. See [Streaming](./streaming.md).

## Without createAgent()

`AgentExecutor.execute()` and `AgentExecutor.stream()` take the same
`output` option. There `result.object` is `unknown`; parse it again with your
schema, or use `createAgent()` for the inferred type.

```ts
import { z } from 'zod';
import { AgentBuilder, AgentExecutor, createMockProvider } from '@loushy/build-ai-agent';

const Ticket = z.object({ title: z.string(), priority: z.enum(['low', 'high']) });
const agent = AgentBuilder.create().setName('triage').setPrompt('You triage bug reports.').build();
const result = await AgentExecutor.execute({ agent, input: 'The app crashes on login', provider: createMockProvider(), output: Ticket });
const ticket = result.object === undefined ? undefined : Ticket.parse(result.object);
```

## Testing

With `mockModel`, script the JSON text the model would write:

```ts
import { z } from 'zod';
import { createAgent } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel(['{"city":"Paris","tempC":21}']), output: z.object({ city: z.string(), tempC: z.number() }) });
const { object } = await agent.send('Weather in Paris?');
console.log(object?.city); // 'Paris'
```
