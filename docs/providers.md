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

## Where each provider runs

All providers run on Node. The `cloudflare-worker` deploy target supports
`mock`, `openai` and `anthropic`; `ollama` and `openrouter` need the
`node-server` or `docker` target (see [Deployment](./deployment.md#cloudflare-worker)).
