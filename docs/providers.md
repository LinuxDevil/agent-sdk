# Providers

An `LLMProvider` is what an agent generates with. The SDK ships OpenAI,
Anthropic, OpenRouter, Ollama and `pi` providers (each backed by an optional
peer package, see [Installation](./installation.md#provider-packages)) and a
deterministic mock for tests. Name one with a `provider/model` string, or pass
a provider instance. The `vendor/` model prefix chooses the provider; with
OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { resolveProvider, LLMProviderRegistry } from '@lousho/build-ai-agent';

// The convenient way — reads the credential from the environment
const openai = resolveProvider('openai/gpt-4o-mini');       // OPENAI_API_KEY
const anthropic = resolveProvider('anthropic/claude-sonnet-5-5'); // ANTHROPIC_API_KEY
const openrouter = resolveProvider('openrouter/openai/gpt-4o-mini'); // OPENROUTER_API_KEY
const ollama = resolveProvider('ollama/llama3.1');           // OLLAMA_BASE_URL
// pi runs one catalog through `pi/<pi-provider>/<model>` (nested slashes ok):
const pi = resolveProvider('pi/openrouter/openai/gpt-4o-mini');    // OPENROUTER_API_KEY

// Or construct a provider directly via the registry
const custom = LLMProviderRegistry.create('openai', {
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o-mini',
});
```

## Choosing the provider in `createAgent()`

`createAgent()` takes exactly one of:

1. **`model: 'provider/model'`** - resolved with `resolveProvider()`; the key
   comes from the provider's conventional environment variable (see
   [Provider credentials](./configuration.md#provider-credentials)).
2. **`provider: <LLMProvider>`** - your own provider, a configured built-in
   one, or a mock. You may also pass `model` (a bare id such as `'gpt-4o'`): it
   becomes this agent's model, overriding the provider's default.
3. **Neither** - resolved from the environment: `LOUSHO_MODEL` (a
   `provider/model` string) if set, otherwise the first of `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` that is
   present. With none set it throws an error listing the fixes.

```ts
import { createAgent, createMockProvider, resolveProvider } from '@lousho/build-ai-agent';

const fromString = createAgent({ model: 'anthropic/claude-sonnet-5-5' });
const fromInstance = createAgent({ provider: resolveProvider('openai/gpt-4o-mini'), model: 'gpt-4o' });
const offline = createAgent({ provider: createMockProvider({ responses: ['Hi! How can I help?'] }) });
```

Misconfiguration errors say how to fix themselves: a missing key names the
variable, an unknown prefix lists the supported ones and suggests the closest,
and a missing peer package prints the exact `npm install` command.

### Retries and fallback models

`createAgent()` retries a failed model call (rate limit, timeout, network
error, 5xx) twice by default, and with `fallbackModels` moves on to the next
model when the call still fails:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3 }, // or false
  fallbackModels: ['anthropic/claude-haiku-4-5', 'openrouter/meta-llama/llama-3.3-70b-instruct'],
});
```

The `model` string and each fallback are resolved with the `ai` SDK's own
retries off, so `retry` is the only retry layer. A `provider` instance is
wrapped only when you set `retry`. `agent.stream()` reports `provider.retry`
and `provider.fallback` events. Details in
[Provider retries and fallback](./configuration.md#provider-retries-and-fallback).

## Which model runs?

In order: the agent's own `settings.model` (set with
`AgentBuilder.setSettings({ model })`, or `model` next to `provider` in
`createAgent()`), then the model the provider was built with
(`resolveProvider('openai/gpt-4o-mini')`, a spec's `provider.model`, or
`defaultModel`), then the provider's built-in default. That last default only
applies when nothing configured a model — a model you set is never overridden
by a hard-coded one.

## Multimodal input

`Message.content` is a string or a list of parts: `{ type: 'text', text }`,
`{ type: 'image', image, mimeType? }` (an `http(s)` URL, a `data:` URL or the
bytes as a `Uint8Array`) and `{ type: 'file', data, mimeType, filename? }`.
`agent.send()`, `agent.stream()`, `session.send()` / `stream()`, `t.send()` in
evals and the React hook's `send()` all take an `AgentInput`: a string, a list
of parts (sent as one user message) or a `Message[]` (passed through as it is).
Parts sent through `createAgent()`:

```ts
import { readFileSync } from 'node:fs';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'Describe images briefly.', model: 'openai/gpt-4o-mini' });

// Parts become one user message.
const answer = await agent.send([
  { type: 'text', text: 'What is in these pictures?' },
  { type: 'image', image: 'https://example.com/cat.png' },
  { type: 'image', image: new Uint8Array(readFileSync('dog.png')), mimeType: 'image/png' },
]);
console.log(answer.text);
```

A `Message[]` is passed through as it is; `textOf()` returns the text parts of a message:

```ts
import { createAgent, textOf, type Message } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'Describe images briefly.', model: 'openai/gpt-4o-mini' });
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', image: 'https://example.com/cat.png' },
    ],
  },
];

const result = await agent.send(messages);
console.log(textOf(messages[0]), '->', result.text);
```

- **Images** go to the model on `user` messages with every built-in provider
  (an image URL is downloaded by the `ai` SDK first for Anthropic and Ollama;
  `pi` sends `data:` URLs and bytes only - an `http(s)` URL degrades to a text
  note with a one-time warning). Pick a vision model: Ollama ignores images
  for a text-only model, and OpenRouter rejects them for one.
- **Files** (`{ type: 'file', data, mimeType }`) are sent as `file` parts for
  these media types, by provider and `ai` major:

  | Provider | `ai` 4 | `ai` 6 / 7 |
  | -------- | ------ | ---------- |
  | `openai` | text note | `application/pdf` |
  | `anthropic` | text note | `application/pdf`, `text/plain` |
  | `openrouter` | text note | `application/pdf` |
  | `ollama` | text note | text note |
  | `pi` | text note | text note (pi has no file part) |

  Any other file part is sent as a text note
  (`[file report.pdf (application/pdf) not sent]`), and the provider warns once
  per media type, naming it and the `ai` major. On `ai` 4 the accepted
  `@ai-sdk/*` range includes 0.0.x packages that have no file parts, so every
  file becomes the note there. A provider subclass whose model takes more types
  overrides `protected fileMediaTypes(): readonly string[]` to list them, or
  sets `protected readonly acceptsFileParts = true` to send every type.
- `system`, `assistant` and `tool` messages are sent as their text parts.
- Everything that reads message text uses `textOf()`: `estimateTokens()`
  (each image or file part counts as a flat 1,000 tokens), compaction,
  `recordReplay()` cassettes (which store the text and a digest of each
  image or file, or its URL) and `mockModel()`. `FileSessionStore` saves bytes
  as base64 (`{ "$bytes": "..." }`) and loads them back as `Uint8Array`s;
  `SqliteStore` (sessions and checkpoints) does the same.

#### Advanced: the executor API

`AgentExecutor.execute()` takes the same messages as its `input` (see [the executor API](./executor-api.md)):

```ts
import { AgentBuilder, AgentExecutor } from '@lousho/build-ai-agent/executor';
import { resolveProvider, type Message } from '@lousho/build-ai-agent';

const agent = AgentBuilder.create().setName('vision').setPrompt('Describe images briefly.').build();
const input: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', image: 'https://example.com/cat.png' },
    ],
  },
];

const result = await AgentExecutor.execute({ agent, input, provider: resolveProvider('openai/gpt-4o-mini') });
console.log(result.text);
```

## Provider classes

| Export | Description |
| ------ | ----------- |
| `resolveProvider('p/model')` | Build a real provider from environment credentials. |
| `LLMProviderRegistry` | Registry of provider factories: `create(type, config)`, `register(type, factory)`, `has(type)`. |
| `OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, `OpenRouterProvider`, `PiProvider` | The provider classes. See [examples/openrouter](../examples/openrouter) for OpenRouter-specific features. `PiProvider` is the `pi/...` adapter below. |
| `createMockProvider()`, `MockLLMProvider` | Canned responses for demos; simulates a tool call when the message names a tool. |
| `mockModel(script)` | Scripted, asserting provider for tests (from `/testing`); see [Testing](./testing.md). |
| `withRetry()`, `withFallback()` | Retry transient failures with backoff and fall back to the next provider; see [Provider retries and fallback](./configuration.md#provider-retries-and-fallback). |
| `fromAiSdk(model, options?)` | Any AI SDK `LanguageModel` (Google, Bedrock, Azure, Mistral, the Gateway, ...) as a provider; see [below](#any-ai-sdk-model-fromaisdk). |

To use another backend, first check whether it has an AI SDK provider package:
then wrap its model with `fromAiSdk()` (below). Otherwise implement the
`LLMProvider` interface (`name`, `generate()`, `stream()`, `supportsTools()`,
`supportsStreaming()`, `getModels()`, optionally `defaultModel`) and pass the
instance as `provider`, or register a factory with
`LLMProviderRegistry.register(name, factory)`.

### Any AI SDK model: fromAiSdk()

`fromAiSdk(model)` turns a language model from any AI SDK provider package
into an `LLMProvider`, so you do not write an adapter:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const agent = createAgent({
  provider: fromAiSdk(openai.chat('gpt-4o-mini'), { fileMediaTypes: ['application/pdf'] }),
  instructions: 'You are a helpful assistant.',
});
```

The same works with `@ai-sdk/google` (`google('gemini-2.5-flash')`),
`@ai-sdk/amazon-bedrock`, `@ai-sdk/azure`, `@ai-sdk/mistral` and the AI Gateway
(`gateway('openai/gpt-4o')` from `ai` 7 or `@ai-sdk/gateway`). Calls go through
your installed `ai`, so install the provider package major that pairs with it
(see [Vercel AI SDK versions](#vercel-ai-sdk-versions)).

| Option | Default | Description |
| ------ | ------- | ----------- |
| `name` | the model's `provider` field, else `'ai-sdk'` | Provider name in events, spans and warnings. |
| `fileMediaTypes` | `[]` | Media types sent as `file` parts; other file parts become a text note. Images are always sent. |
| `replaysReasoning` | `false` | Send signed reasoning blocks back on assistant turns (Anthropic models). |
| `maxRetries` | `0` | The AI SDK's own retries per call; `createAgent()` retries through its `retry` option. |

The provider serves the one model it wraps, with tools and streaming on, and
leaves reasoning settings to the model you built (the `reasoning` option is not
mapped). Each throws `LOUSHO_CONFIG_INVALID`:

- a model id string (`fromAiSdk('openai/gpt-4o')`): pass the provider
  function's model instead;
- a model for another `ai` major than the installed one (a
  `specificationVersion: 'v1'` model with `ai` 6 / 7, or a newer one with
  `ai` 4);
- a run with another `model` id than the wrapped one (inside a run it is the
  cause of the `LOUSHO_PROVIDER_REQUEST_FAILED` error): wrap each model with
  `fromAiSdk()` and combine them with `withFallback()`.

### The `pi` provider

`pi/<pi-provider>/<model>` routes a call through
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
(the engine `pi-coding-agent` runs on), an optional peer that needs no `ai`
package:

```bash
npm install @earendil-works/pi-ai@1.0.3
```

```ts
import { createAgent } from '@lousho/build-ai-agent';

// OpenRouter's `openai/gpt-4o-mini`, through pi's openrouter adapter:
const agent = createAgent({ model: 'pi/openrouter/openai/gpt-4o-mini' });
```

The segment after `pi/` is a **pi provider** (`openrouter`, `anthropic`,
`openai`, `google`, ...); the rest is the catalog model id verbatim, slashes
included. Credentials are per nested provider: pi reads each one's own
conventional env var (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, ...), so a
`pi/anthropic/...` spec never sees an OpenRouter key. `lousho init
--provider pi` scaffolds the `pi/openrouter/...` default. A nested provider
whose key is missing fails the call with `LOUSHO_PROVIDER_MISSING_API_KEY`
naming the variable, and a missing `@earendil-works/pi-ai` fails it with the
usual `MissingPeerDependencyError`.

What maps, per call:

- messages: `system` to pi's `systemPrompt`, `user`/`assistant`/`tool` in
  place; assistant `reasoning` blocks become thinking parts and a `tool`
  message's `toolCallId` links it to its call;
- tools: `parameters` is sent as JSON Schema - raw JSON Schema, zod 3, zod 4
  and Standard Schema inputs are converted once and cached;
- streams: pi's `text_delta`/`thinking_delta`/`toolcall_*`/`done`/`error`
  events become the same `text-delta`/`reasoning-*`/`tool-call`/`finish`/
  `error` chunks the `ai` providers emit, so `agent.stream()` events and
  `result.usage` are unchanged;
- usage and cost: pi's per-call usage (including `cacheRead`) is carried
  into the run total, and the catalog's prices register the model for the
  run's `usage.costUsd`;
- retries: pi's own `maxRetries` is pinned off - `retry`/`fallbackModels`
  stay the only retry layer, like every built-in.

`PiProviderConfig.models` injects catalog entries (pi's faux provider, a
private catalog) ahead of the built-in list. `pi` is Node-only: the
`cloudflare-worker` target refuses `pi/...` specs and its bundle redirects
the package to a coded shim.

## Vercel AI SDK versions

Every built-in provider except `pi` is an adapter over the Vercel AI SDK
(`ai`). What works
on each major today:

| `ai` | `generate()` | `stream()` | Notes |
| ---- | ------------ | ---------- | ----- |
| v4 (`^4.3.19`) | Yes | Yes | Everything in these docs. |
| v6 (`^6.0.0`), v7 (`^7.0.0`) | Yes, through a compatibility layer | Yes, through the same layer | Ollama needs zod 4 installed (below). |

The peer ranges accept all three majors. Pair each with its
provider packages:

| `ai` | `@ai-sdk/openai`, `@ai-sdk/anthropic` | Ollama package |
| ---- | ------------------------------------- | -------------- |
| `^4.3.19` | `^0.0.42` or `^1.0.0` | `ollama-ai-provider@^1.2.0` |
| `^6.0.0` | `^3.0.0` | `ollama-ai-provider-v2@^3.0.0` |
| `^7.0.0` | `^4.0.0` | `ollama-ai-provider-v2@^4.0.0` |

The install hint of a missing provider package and `lousho doctor` name the
version for the `ai` you have installed, and `lousho doctor` flags a mismatched
pair (for example `ai` 7 with `@ai-sdk/openai` 1.x). `OllamaProvider` loads
`ollama-ai-provider` on `ai` 4 and `ollama-ai-provider-v2` on `ai` 6/7; the v2
package peers on zod 4, which the SDK accepts, so install zod 4
with it (zod 3 projects use Ollama with `ai` 4). `lousho init` scaffolds `ai@^7.0.0` with `@ai-sdk/*@^4.0.0` for
OpenAI, Anthropic and OpenRouter, and `ai@^7.0.0` with `ollama-ai-provider-v2@^4.0.0` and zod 4 for Ollama.

CI installs and tests `ai` 4, 6 and 7, each with zod 3 and zod 4 (six pairings;
`ai` 4 with zod 4 is the one pairing the provider packages do not declare), with
the real `ollama-ai-provider-v2` on `ai` 6 and 7 in the zod 4 jobs.

OpenRouter uses `@ai-sdk/openai` against OpenRouter's base URL. From
`@ai-sdk/openai` 2 on, the default `openai(modelId)` call targets the Responses
API, which OpenRouter does not implement, so `OpenRouterProvider` asks for the
Chat Completions model (`provider.chat(modelId)`) on every major; it works on
`ai` 4, 6 and 7 with the pairing above.

`OllamaProvider` takes the server's base URL (`baseURL`, or `OLLAMA_BASE_URL`
for `resolveProvider()`) and appends `/api` to a bare host, as both Ollama
packages expect it: `http://host:11434` and `http://host:11434/` become
`http://host:11434/api`. A URL that already ends in `/api` (or `/api/`), or has
any other path such as a reverse-proxy prefix, is used as it is.

`generate()` and `stream()` pick the call shape from the installed `ai`
module: when it exports `stepCountIs` (v5 and later), the request is sent in
the v6/v7 shape and the result is read back into the same `GenerateResult`
or `StreamResult`:

- messages become `ModelMessage`s: a tool call's arguments are its `input`, a
  tool result is an `output` (`json` or `text`, `error-json` or `error-text`
  when the tool failed), and an image or file part's `mimeType` is its
  `mediaType`. System messages are kept in place (`allowSystemInMessages`).
- `maxTokens` is sent as `maxOutputTokens`, one step as `stopWhen:
  stepCountIs(1)`, tools as `inputSchema` (a zod schema as it is, a JSON
  Schema through `jsonSchema()`) with no `execute`, and `responseFormat` as a
  JSON-mode `output` that leaves the reply text alone.
- usage comes from `inputTokens` / `outputTokens` / `totalTokens`, with
  `cachedInputTokens` from `inputTokenDetails.cacheReadTokens` and
  `reasoningTokens` from `outputTokenDetails.reasoningTokens`.
- `stream()` reads the SDK's `fullStream` on either major into the same
  chunks: `text-delta` (v6/v7 `text`, v4 `textDelta`), `tool-call` (the
  whole call v6/v7 sends after `tool-input-start`/`-delta`/`-end`, or one
  assembled from that input when the model sends none), and `finish` with
  the SDK's finish reason and the usage above (v6/v7 `totalUsage`). An
  `error` part rejects the stream with its error, on v4 too (v4 used to end
  such a stream with finish reason `error`), and an `abort` part with the
  signal's reason. Reasoning deltas are reported as `reasoning-delta` chunks and
  surface as `reasoning.*` events (see [Reasoning](./reasoning.md)).

On v6/v7 the model must come from a provider package for that major (the
table above); the `0.0.x`/`1.x` packages produce models `ai` v7 rejects. Image
parts are sent as `file` parts with an image media type (the shape `ai` v6/v7
takes for images, so there is no deprecation warning). `ai` v5 is not supported.

## Where each provider runs

All providers run on Node. The `cloudflare-worker` deploy target supports
`mock`, `openai`, `anthropic` and `openrouter` (key from the
`OPENROUTER_API_KEY` binding); `ollama` and `pi` need the `node-server` or
`docker` target (see [Cloudflare Workers](./cloudflare-workers.md)).
