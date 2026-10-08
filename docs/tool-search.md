# Tool search

An agent with many tools (several MCP servers, a large internal toolkit) sends
every tool definition on every model call. That costs input tokens and, past
about 30 tools, makes the model worse at picking the right one. With tool
search, tools marked `deferLoading` are left out of the request. The model gets
one built-in tool, `tool_search`, finds what it needs with a few words, and the
tools it found are sent from its next step on.

The search runs in the SDK, so it works with every provider.

## When to use it

- The agent is connected to MCP servers with many tools, or has a large tool
  set, and most runs use only a few of them.
- The tool definitions take a noticeable share of the context window.

With a handful of tools there is nothing to gain: by default deferral only
applies when the deferred definitions reach 10% of the context window (see
[The threshold](#the-threshold)).

## Mark tools or servers `deferLoading`

Mark single tools with `defineTool({ deferLoading: true })`. The `vendor/`
model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const convertCurrency = defineTool({
  name: 'convert_currency',
  description: 'Convert an amount of money from one currency to another',
  input: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
  deferLoading: true,
  execute: async ({ amount, to }) => ({ amount: amount * 0.92, currency: to }),
});

const lookupStock = defineTool({
  name: 'lookup_stock',
  description: 'Look up the latest price of a stock ticker',
  input: z.object({ ticker: z.string() }),
  deferLoading: true,
  execute: async ({ ticker }) => ({ ticker, price: 123.45 }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a helpful assistant.',
  tools: [convertCurrency, lookupStock],
  toolSearch: { thresholdPercent: 0 }, // defer even this small set (see below)
});
```

Or mark a whole MCP server: every tool it lists is deferred.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  mcpServers: {
    github: { url: 'https://example.com/github/mcp', deferLoading: true },
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  },
});
```

`deferLoading` works the same in spec files and agent directories
(`mcpServers.<name>.deferLoading: true`), and with `connectMcp()`: the
descriptors it returns carry `deferLoading`, so passing `mcp.tools` to
`createAgent({ tools })` keeps the deferral.

Never deferred, whatever they are marked: `load_skill` ([skills](./skills.md)),
memory tools, `task` and the background task tools ([sub-agents](./sub-agents.md)),
`ask_question`, the `transfer_to_<name>` tools of [handoffs](./handoffs.md), and
`tool_search` itself. Hosted provider tools are always sent.

## What the model sees

When deferral applies, a run's first request has the tools that are not
deferred plus `tool_search`, and the system prompt gets one paragraph: how many
tools are not loaded, the MCP servers they come from (with counts), and to call
`tool_search` with a few words describing the capability needed.

`tool_search` takes `{ query: string }` and returns JSON:

```json
{ "loaded": [{ "name": "convert_currency", "description": "Convert an amount of money from one currency to another" }], "more": 38 }
```

`loaded` lists the tools found by this search (at most `maxResults`); `more`
counts the deferred tools still not loaded. From the next step on, the
request includes them. Once every deferred tool is loaded, `tool_search` is no
longer offered.

A deferred tool the model calls by name before it is loaded runs like any other
tool (approvals, permissions and guardrails apply as usual). `stream()` reports
`tool_search` as an ordinary `tool.start` / `tool.done` pair.

The default ranking compares the query's words with each deferred tool's name
(split on `_`, `-`, `__` and camelCase) and description, case-insensitively.
A word found in the name counts three times as much as one found in the
description; ties are ordered by name. The same function is exported as
`rankToolsByKeywords(query, tools)`.

## `toolSearch` options

`createAgent({ toolSearch })` and `AgentExecutor.execute({ toolSearch })` tune
the search. Deferral itself is turned on by marking tools or servers
`deferLoading`; `toolSearch: false` loads every tool upfront.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `thresholdPercent` | `0.1` | Defer only when the deferred definitions reach this share of the context window. `0` always defers. |
| `maxResults` | `5` | Tools loaded per search. |
| `contextWindow` | the model registry, else 128,000 | The model's context window, for the threshold. The 128,000 fallback logs a one-time `console.warn`; set it (or `registerModel()`) for local models. |
| `search(query, tools)` | keyword ranking | Your own ranking (for example embeddings): return tool names, best first. Unknown names and duplicates are dropped. If it throws, the call is a tool error and loads nothing. |

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  mcpServers: { github: { url: 'https://example.com/github/mcp', deferLoading: true } },
  toolSearch: {
    maxResults: 3,
    search: (query, tools) => tools.filter((tool) => tool.description.toLowerCase().includes(query.toLowerCase())).map((tool) => tool.name),
  },
});
```

An invalid value throws `LOUSHO_CONFIG_INVALID` when the agent is created. A
tool of your own called `tool_search` throws `LOUSHO_CONFIG_INVALID` when a run
starts with deferral active: rename it, or set `toolSearch: false`.

## The threshold

When a run starts, the SDK estimates the tokens of the deferred definitions
(name, description and JSON Schema of each, with `estimateTokens()` for the
run's model). Below `thresholdPercent` of the context window, every tool is
sent upfront and no `tool_search` tool is added: the definitions are cheap, and
a search step would cost more than it saves. This is the same rule as the
Claude Agent SDK's `auto` mode.

The live test of this feature (40 one-line tools on `gpt-4o-mini`) measured
157 input tokens on the first call with deferral and 892 without.

## How loading persists

Which tools are loaded is not stored anywhere: it is read from the transcript
at each model call. A tool is loaded when a successful `tool_search` result in
the run's messages names it. So:

- A crash resume from a checkpoint, an approval pause and its resume, a fork,
  and the next turn of a session keep the loaded tools.
- A resume does not report [agent drift](./durable-execution.md#resuming-with-a-changed-agent)
  because of loading: the fingerprint covers every tool, deferred or not.
- [Compaction](./compaction.md) that prunes a `tool_search` result unloads its
  tools from the next model call on; the model searches again when it needs
  them.
- A [handoff](./handoffs.md) target starts with nothing loaded, even when it
  has the same deferred tools: only `tool_search` results after the last
  handoff count, and the target's own `deferLoading` tools and `toolSearch`
  apply. A [sub-agent](./sub-agents.md) runs its own tool list on its own
  transcript, so it never inherits what the lead loaded.

## MCP servers that need a sign-in

Listing a server's tools needs a connection, so a `deferLoading` server with
[OAuth](./oauth.md#mcp-servers-with-oauth) that is not signed in fails the run
with `LOUSHO_MCP_AUTH_REQUIRED` like any other server. Once the operator signs
in, its tools are deferred as usual. A grant revoked later turns a call of a
loaded tool into a `LOUSHO_MCP_AUTH_REQUIRED` tool error, as without deferral.

## Prompt caching

The tool list changes when tools load. Providers that cache the request prefix
(Anthropic prompt caching, OpenAI's automatic caching) put tool definitions at
the start of it, so a step that loads tools can miss the cache from that point.
Loading happens a few times per run at most; if your runs reuse a long cached
prefix across many calls, compare the cost with `toolSearch: false`.
