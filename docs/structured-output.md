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
schema's own `safeParse` either way. `output` is typed as a Standard Schema,
the same as `defineTool({ input })`, so `result.object` is inferred without a
cast from a zod 3 schema, a zod 4 schema (`zod/v4` on zod 3.25, or zod 4
itself) or any other Standard Schema that can produce JSON Schema:

```ts
import { z } from 'zod/v4';
import { createAgent } from '@loushy/build-ai-agent';

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
import { createAgent } from '@loushy/build-ai-agent';

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
[`remoteAgent()`](./sub-agents.md#remote-sub-agents) returns its text only: the
session client's turn summary does not carry the remote's `object`.

```ts
import { z } from 'zod';
import { createAgent } from '@loushy/build-ai-agent';

const reporter = createAgent({
  model: 'openai/gpt-4o-mini',
  description: 'Reports the weather as { city, tempC }',
  output: z.object({ city: z.string(), tempC: z.number() }),
});
const lead = createAgent({ model: 'openai/gpt-4o-mini', subagents: { reporter } });
const result = await lead.send('What is the weather in Paris?');
console.log(result.text);
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
