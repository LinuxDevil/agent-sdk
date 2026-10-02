# Hosted provider tools

Some model providers run tools themselves, inside the model request: OpenAI's
web search, code interpreter and file search are the common ones. Put them in
`tools` next to your own tools; the provider runs them, and the run reports
each call in its events, keeps it on the transcript and counts it in usage.

```ts
import { createAgent, webSearch, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const saveNote = defineTool({
  name: 'save_note',
  description: 'Save a note',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ saved: text.length }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'Answer with sources.',
  tools: [webSearch({ searchContextSize: 'low' }), saveNote],
});

const result = await agent.send('What changed in Node 24?');
console.log(result.text, result.usage.hostedToolCalls); // { web_search: 1 }
```

The SDK never executes a hosted tool. It sends it with every model call of
the run and reports what the provider did.

## The helpers

| Helper | Name | Options |
| --- | --- | --- |
| `webSearch(options?)` | `web_search` | `searchContextSize` (`'low' \| 'medium' \| 'high'`), `userLocation` (`{ country, city, region, timezone }`), `allowedDomains`, `blockedDomains`, `maxUses` |
| `codeInterpreter(options?)` | `code_interpreter` | `container`: an existing container id; by default the provider creates one |
| `fileSearch({ vectorStoreIds, maxResults? })` | `file_search` | `vectorStoreIds` (at least one; vector stores you created with the provider), `maxResults` |
| `hostedTool(name, aiSdkTool)` | `name` | Any AI SDK provider tool object, passed through as it is |

`isHostedTool(value)` tells a hosted tool from a local one. Each helper's
name is also the name the model, the events and `usage.hostedToolCalls` use.
In the record form of `tools` a hosted tool's key must be its name
(`tools: { web_search: webSearch(), lookup }`). A hosted tool with the name of
another tool is a `LOUSHO_CONFIG_INVALID` error when the agent is created.

A provider uses the options it supports. OpenAI takes `searchContextSize`,
`userLocation` and `allowedDomains`; it has no `maxUses` or `blockedDomains`,
so those are dropped with one `console.warn`.

## Which provider runs which

| Tool | OpenAI | Anthropic | OpenRouter | Ollama | `fromAiSdk()` / other AI SDK providers |
| --- | --- | --- | --- | --- | --- |
| `webSearch()` | ✅ `ai` 6 + `@ai-sdk/openai` 3, `ai` 7 + `@ai-sdk/openai` 4 | see N1b | see N1b | ❌ | ❌ (use `hostedTool()`) |
| `codeInterpreter()` | ✅ same pairings | see N1b | see N1b | ❌ | ❌ (use `hostedTool()`) |
| `fileSearch()` | ✅ same pairings | see N1b | see N1b | ❌ | ❌ (use `hostedTool()`) |
| `hostedTool()` | ✅ `ai` 6 or 7 | ✅ `ai` 6 or 7 | ✅ `ai` 6 or 7 | ✅ `ai` 6 or 7 | ✅ `ai` 6 or 7 |

Hosted tools need `ai` 6 or 7. With `ai` 4 (and its `@ai-sdk/openai` 0.0.x
or 1.x) every hosted tool is refused. On OpenAI the model is the Responses API
model, which `@ai-sdk/openai` gives from version 2 on. An unsupported
pairing rejects the run before the first model call with
[`LOUSHO_HOSTED_TOOL_UNSUPPORTED`](./errors.md#lousho_hosted_tool_unsupported),
naming the provider, the tool and what would work.

A custom `LLMProvider` declares what it can send with
`supportsHostedTool(type)` (`type` is `'web_search'`, `'code_interpreter'`,
`'file_search'` or `'custom'` for `hostedTool()`) and receives the tools in
`GenerateOptions.hostedTools`. A provider without that method supports none.
`withRetry()` and `withFallback()` ask the (first) wrapped provider.

## Any AI SDK provider tool: hostedTool()

`hostedTool(name, tool)` sends a provider tool object you built with the
provider's package, unchanged, on `ai` 6 or 7. It works with the built-in
providers and with any AI SDK model wrapped by
[`fromAiSdk()`](./providers.md#any-ai-sdk-model-fromaisdk):

```ts no-verify
import { createAgent, fromAiSdk, hostedTool } from '@lousho/build-ai-agent';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  provider: fromAiSdk(openai('gpt-4o-mini')),
  tools: [hostedTool('image_generation', openai.tools.imageGeneration())],
});
```

Use the name the provider package documents for its tool.

## Events

A hosted call is reported like a tool call, with `executedBy: 'provider'` on
`tool.start`, `tool.done` and `tool.error`:

```ts
import { createAgent, webSearch } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [webSearch()] });

for await (const event of agent.stream('Latest TypeScript release?')) {
  if (event.type === 'tool.start' && event.executedBy === 'provider') console.log('provider runs', event.toolName, event.args);
  if (event.type === 'tool.done' && event.executedBy === 'provider') console.log('provider result', event.result);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

In a streamed model call the events arrive as the provider reports the call;
in a call made without streaming they follow the call, in call order, before
its text. `tool.done.result` is capped at 20,000 characters of JSON (a longer
result becomes the cut JSON text ending in `... [truncated N characters]`);
`tool.error` has `error.name` `'HostedToolError'` and the provider's message.
The AI SDK UI stream (`toUIMessageStream()`) marks these tool parts
`providerExecuted: true`.

In traces, the `chat` span of the model call carries
`lousho.hosted_tool_calls` (the names of the tools the provider ran in it);
there is no `execute_tool` span for them, since the SDK ran nothing.

## Transcript and replay

The assistant message of the step gets `metadata.hostedToolCalls`: each call's
`id`, `name`, `args`, `result` (capped as above), `isError` and the url
`sources` the provider cited after it. Find them in `result.messages`.

Only the assistant's text is sent back to the model on later calls, never the
provider's tool blocks. That works on every provider and model; the cost is
that citations from earlier turns are not replayed to the model.

## Usage and cost

`result.usage.hostedToolCalls` (and `run.done` `usage.hostedToolCalls`) counts
the calls per tool name, for example `{ web_search: 2 }`; a sub-agent's calls
are added to the lead's. The tokens a hosted tool adds (search results the
model reads, code output) are in the token counts the provider reports.

`costUsd` covers tokens only. Per-call fees for hosted tools (a web search or
a code interpreter session) are billed by the provider and are **not**
included; check the provider's pricing and use the counts above.

## Approvals and permissions

The SDK cannot gate what it does not execute. A hosted tool runs inside the
provider's request, so no permission rule, tool guardrail, `needsApproval`,
`preToolCall` / `postToolCall` hook or `onToolCall` sees it, and **a hosted
tool cannot be paused for approval**. If a run must not search or run code
without a human, leave the tool out of `tools`, or choose tools per run with a
function:

```ts
import { createAgent, webSearch } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  tools: ({ metadata }) => (metadata?.allowSearch ? [webSearch()] : []),
});

await agent.send('Summarize this page.', { metadata: { allowSearch: true } });
```

[Permission modes](./permission-modes.md) cannot refuse a hosted call either,
so they decide which hosted tools are sent with each model call:

| Mode | `webSearch()`, `fileSearch()` | `codeInterpreter()`, `hostedTool()` |
| --- | --- | --- |
| `'default'` | Sent | Sent |
| `'plan'` | Sent (they only read) | **Not sent**: the model does not see them |
| `'acceptEdits'` | Sent | Sent |
| `'dontAsk'` | Sent (a hosted call never asks) | Sent |

A code interpreter runs code, and a `hostedTool()` is a tool the SDK knows
nothing about, so plan mode treats both as tools with side effects. The mode is
read before every model call, so a switch (`session.setPermissionMode()` or a
function mode) applies from the next call. No `permission.decision` entry is
written for a hosted tool left out: no call was made.

Sub-agents do not inherit the lead's hosted tools; give a sub-agent its own
in its `tools`. A run resumed from a checkpoint or an approval sends the same
hosted tools; a resuming agent with a different set reports
[agent drift](./durable-execution.md).

## Testing

`mockModel` takes hosted calls in a turn and records `hostedTools` on each
request, so an agent with hosted tools runs offline:

```ts
import { createAgent, webSearch } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const model = mockModel([
  {
    text: 'Node 24 ships npm 11.',
    hostedToolCalls: [{ name: 'web_search', args: { query: 'node 24' }, result: { hits: 3 }, sources: [{ url: 'https://nodejs.org' }] }],
  },
]);
const agent = createAgent({ provider: model, tools: [webSearch()] });
const result = await agent.send('What changed in Node 24?');

console.log(model.calls[0]?.hostedTools?.[0]?.name); // 'web_search'
console.log(result.usage.hostedToolCalls); // { web_search: 1 }
```

## Not covered yet

Image generation, computer use, hosted MCP and hosted shell have no helpers;
pass the provider package's tool with `hostedTool()` where it works.
Replaying provider tool blocks to keep citations across turns is not
supported.
