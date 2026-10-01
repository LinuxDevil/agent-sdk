# Testing agents

`@loushy/build-ai-agent/testing` ships `mockModel`: a scripted, deterministic
`LLMProvider` for unit tests. You write down what the model should say on each
turn, run your agent, and then assert on exactly what the agent sent to the
model. No network, no API keys, no flakiness.

```bash
npm install --save-dev vitest
```

The same subpath still exports the in-memory repository mocks
(`MockAgentRepository`, `MockSessionRepository`, ...).

## A text reply

A bare string is shorthand for `{ text }`.

```ts
import { createAgent } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const model = mockModel(['Hello! How can I help?']);
const agent = createAgent({ prompt: 'You are friendly.', provider: model });

const result = await agent.send('hi');

console.log(result.text); // Hello! How can I help?
console.log(model.calls.length); // 1
model.assertExhausted();
```

## A tool-call flow

Each element of the script is one model turn. Turn 1 asks for a tool; the agent
runs it and calls the model again; turn 2 produces the final answer. Tool-call
ids are generated deterministically (`call_1`, `call_2`, ...) unless you pass
`id`.

```ts no-verify
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

describe('weather agent', () => {
  it('calls get_weather and reports the result', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
    const model = mockModel([
      { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, // turn 1
      { text: 'It is 21°C in Paris.' },                                  // turn 2
    ]);
    const agent = createAgent({
      prompt: 'You report the weather.',
      provider: model,
      tools: {
        get_weather: {
          displayName: 'Get weather',
          tool: {
            description: 'Get the weather for a city',
            parameters: z.object({ city: z.string() }),
            execute,
          },
        },
      },
    });

    const result = await agent.send('Weather in Paris?');

    expect(result.text).toBe('It is 21°C in Paris.');
    expect(execute).toHaveBeenCalledWith({ city: 'Paris' }, expect.anything());
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    model.assertExhausted(); // fails if scripted turns were never used
  });
});
```

## An error turn

`{ error }` makes the model call reject, so you can test how your agent behaves
when the provider fails.

```ts no-verify
import { it, expect } from 'vitest';
import { createAgent } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

it('surfaces a provider failure', async () => {
  const model = mockModel([{ error: new Error('upstream 503') }]);
  const agent = createAgent({ prompt: 'x', provider: model });

  await expect(agent.send('hi')).rejects.toThrow();
  expect(model.calls).toHaveLength(1); // the failed request is still recorded
});
```

## Asserting requests

`model.calls` holds a deep-frozen snapshot of every request, in order, so later
mutation by the agent can never rewrite history. Use `model.lastCall` for the
most recent one.

```ts no-verify
expect(model.calls[0].messages[0]).toMatchObject({ role: 'system' });
expect(model.lastCall?.tools?.map((t) => t.function.name)).toContain('get_weather');
expect(model.calls[0].temperature).toBe(0.2);
```

## Dynamic turns

Pass a function to compute a turn from the request. It may be async and may
return a string or any turn object.

```ts
import { mockModel } from '@loushy/build-ai-agent/testing';

const model = mockModel([(req) => `You said: ${req.messages.at(-1)?.content}`]);
const result = await model.generate({ messages: [{ role: 'user', content: 'ping' }] });

console.log(result.text); // You said: ping
```

## Turn reference

| Field          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `text`         | Assistant text (default `''`).                                                 |
| `toolCalls`    | `[{ name, args?, id? }]`. Args are JSON-encoded; ids default to `call_N`.      |
| `error`        | Reject `generate()` / `stream()` with this error.                              |
| `usage`        | `{ inputTokens, outputTokens }` (default zero).                                |
| `finishReason` | Defaults to `'tool_calls'` when there are tool calls, otherwise `'stop'`.      |
| `delayMs`      | Wait before answering (works with `vi.useFakeTimers()`).                       |

## Running out of turns

If the agent calls the model more often than you scripted, `mockModel` throws
an error that names the unexpected call number, shows the last message of the
request and tells you to add a turn. To replay the final turn forever (handy for
loop and step-limit tests), pass `{ onExhausted: 'repeat-last' }`:

```ts
import { mockModel } from '@loushy/build-ai-agent/testing';

const looping = mockModel([{ toolCalls: [{ name: 'again' }] }], { onExhausted: 'repeat-last' });
```

Other helpers: `model.reset()` rewinds the script and clears recorded calls, and
`model.assertExhausted()` throws if scripted turns remain unused.

## Streaming

`mockModel` also implements `stream()`: the scripted text is emitted as
`text-delta` chunks (split on word boundaries), followed by any `tool-call`
chunks and a final `finish` chunk, so streaming consumers can be tested too.
