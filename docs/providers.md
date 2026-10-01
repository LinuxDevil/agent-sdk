# Providers

An `LLMProvider` is what an agent generates with. The SDK ships OpenAI,
Anthropic, OpenRouter and Ollama providers (each backed by an optional peer
package, see [Installation](./installation.md#provider-packages)) and a
deterministic mock for tests. Name one with a `provider/model` string, or pass
a provider instance.

```ts
import { resolveProvider, LLMProviderRegistry } from '@loushy/build-ai-agent';

// The convenient way — reads the credential from the environment
const openai = resolveProvider('openai/gpt-4o-mini');       // OPENAI_API_KEY
const anthropic = resolveProvider('anthropic/claude-sonnet-5'); // ANTHROPIC_API_KEY
const openrouter = resolveProvider('openrouter/openai/gpt-4o-mini'); // OPENROUTER_API_KEY
const ollama = resolveProvider('ollama/llama3.1');           // OLLAMA_BASE_URL

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
3. **Neither** - resolved from the environment: `LOUSHY_MODEL` (a
   `provider/model` string) if set, otherwise the first of `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` that is
   present. With none set it throws an error listing the fixes.

```ts
import { createAgent, createMockProvider, resolveProvider } from '@loushy/build-ai-agent';

const fromString = createAgent({ model: 'anthropic/claude-sonnet-5' });
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
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3 }, // or false
  fallbackModels: ['anthropic/claude-3-5-haiku-latest', 'openrouter/meta-llama/llama-3.1-70b-instruct'],
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
`defaultModel`), then the provider's built-in default. There is no hard-coded
fallback model.

## Multimodal input

`Message.content` is a string or a list of parts: `{ type: 'text', text }`,
`{ type: 'image', image, mimeType? }` (an `http(s)` URL, a `data:` URL or the
bytes as a `Uint8Array`) and `{ type: 'file', data, mimeType, filename? }`.
`agent.send()`, `agent.stream()`, `session.send()` / `stream()`, `t.send()` in
evals and the React hook's `send()` all take an `AgentInput`: a string, a list
of parts (sent as one user message) or a `Message[]` (passed through as it is).
`AgentExecutor.execute()` takes the same messages as its `input`:

```ts
import { readFileSync } from 'node:fs';
import { AgentBuilder, AgentExecutor, createAgent, resolveProvider, textOf, type Message } from '@loushy/build-ai-agent';

const agent = AgentBuilder.create().setName('vision').setPrompt('Describe images briefly.').build();
const input: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in these pictures?' },
      { type: 'image', image: 'https://example.com/cat.png' },
      { type: 'image', image: new Uint8Array(readFileSync('dog.png')), mimeType: 'image/png' },
    ],
  },
];

const result = await AgentExecutor.execute({ agent, input, provider: resolveProvider('openai/gpt-4o-mini') });
console.log(textOf(input[0]), '->', result.text); // textOf(): the text parts of a message

// The same through the public API: parts become one user message.
const answer = await createAgent({ prompt: 'Describe images briefly.', model: 'openai/gpt-4o-mini' }).send([
  { type: 'text', text: 'What is in this picture?' },
  { type: 'image', image: 'https://example.com/cat.png' },
]);
console.log(answer.text);
```

- **Images** go to the model on `user` messages with every built-in provider
  (an image URL is downloaded by the `ai` SDK first for Anthropic and Ollama).
  Pick a vision model: Ollama ignores images for a text-only model, and
  OpenRouter rejects them for one.
- **Files** cannot be sent by the built-in providers' `ai` SDK peers
  (`@ai-sdk/openai` / `@ai-sdk/anthropic` 0.0.x, `ollama-ai-provider`): a file
  part is sent as a text note (`[file report.pdf (application/pdf) not sent]`)
  and the provider warns once. A provider subclass whose model takes files
  sets `protected readonly acceptsFileParts = true` to send them as `ai` v4
  file parts.
- `system`, `assistant` and `tool` messages are sent as their text parts.
- Everything that reads message text uses `textOf()`: `estimateTokens()`
  (each image or file part counts as a flat 1,000 tokens), compaction,
  `recordReplay()` cassettes (which store the text and a digest of each
  image or file, or its URL) and `mockModel()`. `FileSessionStore` saves bytes
  as base64 (`{ "$bytes": "..." }`) and loads them back as `Uint8Array`s;
  `SqliteStore` (sessions and checkpoints) does the same.

## Provider classes

| Export | Description |
| ------ | ----------- |
| `resolveProvider('p/model')` | Build a real provider from environment credentials. |
| `LLMProviderRegistry` | Registry of provider factories: `create(type, config)`, `register(type, factory)`, `has(type)`. |
| `OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, `OpenRouterProvider` | The provider classes. See [examples/openrouter](../examples/openrouter) for OpenRouter-specific features. |
| `createMockProvider()`, `MockLLMProvider` | Canned responses for demos; simulates a tool call when the message names a tool. |
| `mockModel(script)` | Scripted, asserting provider for tests (from `/testing`); see [Testing](./testing.md). |
| `withRetry()`, `withFallback()` | Retry transient failures with backoff and fall back to the next provider; see [Provider retries and fallback](./configuration.md#provider-retries-and-fallback). |

To use another backend, implement the `LLMProvider` interface (`name`,
`generate()`, `stream()`, `supportsTools()`, `supportsStreaming()`,
`getModels()`, optionally `defaultModel`) and pass the instance as `provider`,
or register a factory with `LLMProviderRegistry.register(name, factory)`.

## Vercel AI SDK versions

The built-in providers are adapters over the Vercel AI SDK (`ai`). What works
on each major today:

| `ai` | `generate()` | `stream()` | Notes |
| ---- | ------------ | ---------- | ----- |
| v4 (`^4.3.19`) | Yes | Yes | Everything in these docs. |
| v6 (`^6.0.0`), v7 (`^7.0.0`) | Yes, through a compatibility layer (LOU-D26) | Yes, through the same layer (LOU-D27) | Ollama needs zod 4 installed (below). |

The peer ranges accept all three majors (LOU-D28d). Pair each with its
provider packages:

| `ai` | `@ai-sdk/openai`, `@ai-sdk/anthropic` | Ollama package |
| ---- | ------------------------------------- | -------------- |
| `^4.3.19` | `^0.0.42` or `^1.0.0` | `ollama-ai-provider@^1.2.0` |
| `^6.0.0` | `^3.0.0` | `ollama-ai-provider-v2@^3.0.0` |
| `^7.0.0` | `^4.0.0` | `ollama-ai-provider-v2@^4.0.0` |

The install hint of a missing provider package and `loushy doctor` name the
version for the `ai` you have installed, and `loushy doctor` flags a mismatched
pair (for example `ai` 7 with `@ai-sdk/openai` 1.x). `OllamaProvider` loads
`ollama-ai-provider` on `ai` 4 and `ollama-ai-provider-v2` on `ai` 6/7; the v2
package peers on zod 4, which the SDK accepts since LOU-D29, so install zod 4
with it (zod 3 projects use Ollama with `ai` 4). `loushy init` scaffolds `ai@^7.0.0` with `@ai-sdk/*@^4.0.0` for
OpenAI, Anthropic and OpenRouter, and `ai@^4.3.19` for Ollama.

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
  signal's reason. Reasoning deltas are not reported yet (no reasoning chunk
  type until LOU-V13).

On v6/v7 the model must come from a provider package for that major (the
table above); the `0.0.x`/`1.x` packages produce models `ai` v7 rejects. Image
parts are sent as `image` parts, which `ai` v7 accepts with a deprecation
warning per part (`globalThis.AI_SDK_LOG_WARNINGS = false` turns `ai`'s
warnings off). `ai` v5 is not supported.

## Where each provider runs

All providers run on Node. The `cloudflare-worker` deploy target supports
`mock`, `openai` and `anthropic`; `ollama` and `openrouter` need the
`node-server` or `docker` target (see [Deployment](./deployment.md#cloudflare-worker)).
