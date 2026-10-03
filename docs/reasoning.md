# Reasoning

Reasoning models think before they answer. The `reasoning` option sets how
much, and the run reports what the model thought separately from its answer:
as `reasoning.*` events in `agent.stream()`, and as `result.reasoning`. The
`vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/anthropic/claude-sonnet-4.5`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  instructions: 'You solve puzzles.',
  reasoning: 'medium',
});

for await (const event of agent.stream('Which weighs more, a kilo of feathers or a kilo of lead?')) {
  if (event.type === 'reasoning.delta') process.stdout.write(`\x1b[2m${event.text}\x1b[22m`);
  if (event.type === 'reasoning.done') console.log(`\n(${event.tokens ?? '?'} reasoning tokens)`);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}

// One call can think harder; the object form takes a budget and a summary request.
const result = await agent.send('Prove it.', { reasoning: { effort: 'high', budgetTokens: 16_000 } });
console.log(result.reasoning, result.usage.reasoningTokens);
```

## The option

`reasoning` is an effort, `'none' | 'minimal' | 'low' | 'medium' | 'high'`,
or an object:

| Field | Meaning |
| --- | --- |
| `effort` | As above. Default `'medium'`. |
| `budgetTokens` | A token budget, for providers that take one (Anthropic, OpenRouter). Others use `effort`. |
| `summary` | `'auto'` asks OpenAI's Responses API for a reasoning summary (that is what OpenAI streams as reasoning). |
| `force` | Send the options even when the model is not in the known reasoning families (see below). |

Set it on `createAgent({ reasoning })` for every run, or per call with
`send(input, { reasoning })` / `stream(input, { reasoning })`. A sub-agent
uses its own `reasoning`, not its parent's. `AgentExecutor.execute()` takes
it as `ExecuteOptions.reasoning`, and a custom provider receives it as
`GenerateOptions.reasoning`.

`'none'` sends nothing: the model runs with its provider's default (OpenAI
reasoning models still reason at their default effort).

## Provider mapping

| Provider | Sent as | Effort mapping |
| --- | --- | --- |
| OpenAI | `providerOptions.openai.reasoningEffort` (and `reasoningSummary: 'auto'` with `summary: 'auto'`) | The effort as it is (`'minimal'` is for GPT-5 models). |
| Anthropic | `providerOptions.anthropic.thinking: { type: 'enabled', budgetTokens }` | `minimal` 1024, `low` 2048, `medium` 8192, `high` 24576 tokens; `budgetTokens` overrides (at least 1024, Anthropic's minimum). |
| OpenRouter | The request body's unified `reasoning` field | `{ max_tokens: budgetTokens }` when a budget is given, else `{ effort }`. |
| Ollama | `providerOptions.ollama.think: true` (`ollama-ai-provider-v2`, `ai` 6/7) | On/off only. With `ai` 4 (`ollama-ai-provider`) the option is ignored, with one warning. |

Constraints the provider packages apply for you: `@ai-sdk/anthropic` adds the
thinking budget to `max_tokens` (so the budget always stays below it) and
drops `temperature` and `topP`, which Anthropic does not allow with thinking;
`@ai-sdk/openai` drops `temperature` for reasoning models. Both log a warning
when they drop a setting.

### Which models get it

Options are only sent to model families known to accept them, so a model
that does not reason never gets an unknown-option error:

| Provider | Model ids |
| --- | --- |
| OpenAI | `o1` and later o-series (not `o1-mini` / `o1-preview`), `gpt-5` and later (not the `-chat` models) |
| Anthropic | `claude-3-7-*`, `claude-sonnet-4*`, `claude-opus-4*`, `claude-haiku-4*` and later |
| OpenRouter | `*/o1`..., `*/gpt-5`..., Claude 3.7 / 4+, `deepseek-r1`, `gemini-2.5`+, `grok-3`+, `qwen3`, `:thinking` variants |
| Ollama | `deepseek-r1`, `qwen3`, `gpt-oss`, `magistral` |

For any other model id (a fine-tune, a new family) pass `{ effort, force: true }`.

## Events and results

`agent.stream()` emits `reasoning.start`, then `reasoning.delta` (`text`) as
the model thinks, then `reasoning.done` (`text`: all of it; `tokens` when the
provider has reported reasoning tokens by then). They come inside the step,
before the step's first `text.delta` or `tool.start`. A provider that cannot
stream reports a step's reasoning as one start/delta/done before its text.

`result.reasoning` is the reasoning text of the run's steps, joined with a
blank line. `result.usage.reasoningTokens` (and each `stepUsage` entry) counts
reasoning tokens when the provider reports them; the `chat` span carries them
as `lousho.usage.reasoning_tokens`.

The consumers show it too: `reduceAgentEvents()` keeps it as the assistant
message's `reasoning`, `toUIMessageStream()` emits `reasoning-start` /
`reasoning-delta` / `reasoning-end` parts for `useChat`, `lousho acp` sends
`agent_thought_chunk` updates, and `lousho chat` prints it dimmed.

## What is kept in the transcript

Reasoning is never written into the transcript as text and never sent back
to the model as content, with one exception the provider requires: Anthropic
needs a turn's thinking blocks, unmodified and with their signatures, when it
continues after that turn's tool calls. So:

- An assistant message that made tool calls keeps its signed (or redacted)
  thinking blocks in `message.reasoning`; the Anthropic provider sends them
  back first in that turn. They survive the next step, a checkpoint, a crash
  resume and an approval pause, since they are part of the saved messages.
- Unsigned reasoning (OpenAI, Ollama, OpenRouter) and the reasoning of a
  final reply are not kept in `messages`. OpenAI's encrypted reasoning items
  are not carried between steps.
- Other providers ignore `message.reasoning`.
