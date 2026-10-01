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

## Record and replay

`mockModel` scripts turns by hand. `recordReplay` is the complementary tool: a
VCR for real model behavior. Run your test once against the real provider and
every `generate()` / `stream()` exchange is written to a cassette file. In CI
the same test replays the cassette with no network, no API key and no installed
provider peer package.

```ts
import { createAgent, resolveProvider } from '@loushy/build-ai-agent';
import { recordReplay } from '@loushy/build-ai-agent/testing';

const provider = recordReplay(() => resolveProvider('openai/gpt-4o-mini'), {
  cassette: './__cassettes__/refund-flow.json',
  mode: process.env.LOUSHY_RECORD ? 'record' : 'replay', // or 'auto'
});
const agent = createAgent({ provider, prompt: 'You handle refund requests.' });
```

The first argument is the real provider, or a `() => provider` factory that is
only called when recording (so replay never constructs it). It may be
`undefined` if you only ever replay.

### Workflow

1. Record locally with a key: `LOUSHY_RECORD=1 OPENAI_API_KEY=... npx vitest run`.
2. Review and commit the cassette (it is stable, 2-space indented JSON, so
   diffs are readable).
3. CI runs `npx vitest run` and replays it. Nothing else is needed.
4. When you change the prompt, tools or flow, replay fails with a
   `CassetteMismatchError`; re-record with `LOUSHY_RECORD=1`.

`mode: 'auto'` replays if the cassette file exists and records otherwise.

### What replay checks

By default call N is answered by entry N, but only if the request still matches
what was recorded: model, each message's role, content and tool calls, tool
names and parameter schemas, `temperature` and `maxTokens`. On a mismatch the
error shows the first difference and the re-record hint:

```text
Call #2 does not match the recorded request in ./__cassettes__/refund-flow.json.
First difference at request.messages[1].content:
  recorded: "Refund order 1234"
  actual:   "Refund order 9999"
If the change is intentional, re-record the cassette (run with LOUSHY_RECORD=1, or set mode: 'record').
```

For parallel or unordered calls pass `match: 'request'`: each call finds the
first unused entry with an identical request, in any order. Running out of
entries is also a `CassetteMismatchError`.

Volatile values do not break matching. Timestamps, dates (`2026-10-01`,
`October 1, 2026`), UUIDs and prefixed ids (`call_...`, `toolu_...`,
`chatcmpl_...`) are replaced by placeholders on both sides, and tool-call ids
are ignored (tool calls match by name and arguments). For anything else, pass
`normalize`:

```ts
import { mockModel, recordReplay } from '@loushy/build-ai-agent/testing';

const provider = recordReplay(mockModel(['ok']), {
  cassette: './__cassettes__/users.json',
  normalize: (request) => ({
    ...request,
    messages: request.messages.map((m) => ({ ...m, content: m.content.replace(/user-\d+/g, 'user-N') })),
  }),
});
```

### Errors, streaming and usage

- A provider rejection is recorded and replayed as a rejection with the same
  `name` and `message`.
- `stream()` records the chunks and replays them as an async iterable without
  delays; pass `replayTiming: true` to reproduce the inter-chunk timing. While
  recording, the real stream is read to the end before it is returned.
- Token usage is recorded and replayed, so cost and usage features behave the
  same in replay.

### When the cassette is written

Recording writes the cassette atomically (temp file plus rename) after every
call, so a test that fails midway leaves a valid cassette with every call made
so far, never a half-written one. `await provider.save()` forces a write. There
is no process-exit hook. Each record session starts a fresh cassette and
replaces the old file.

### Redaction (read this before committing)

Cassettes are meant to be committed, so the wrapper only writes a fixed set of
request fields (never headers or provider option bags), never writes
`rawResponse`, and redacts strings that look like API keys (`sk-...`,
`sk-ant-...`, `Bearer ...` tokens and a few other common formats) with
`[REDACTED]`. That is a safety net, not a guarantee: prompts and model replies
are stored verbatim, so personal data, internal URLs and customer text end up in
the file. Pass `redact` to scrub them (it runs on every recorded string, in both
requests and responses, and replay applies it when matching):

```ts
import { mockModel, recordReplay } from '@loushy/build-ai-agent/testing';

const provider = recordReplay(mockModel(['ok']), {
  cassette: './__cassettes__/support.json',
  redact: (text) => text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'),
});
```

### mockModel or cassettes?

Use `mockModel` for unit tests of your own logic: you control every turn, can
inject errors and delays, and nothing depends on a model. Use cassettes when
the point is real model behavior (does this prompt and tool set actually lead
to the right tool call?) and hand-scripting turns would only encode your
assumptions. Cassettes need re-recording when prompts change; `mockModel` tests
only change when the behavior you assert on changes.
