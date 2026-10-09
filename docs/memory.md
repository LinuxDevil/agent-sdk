# Memory

A [session](./sessions.md) remembers one conversation. Memory is what an agent
keeps **across** conversations: a user's preferences, facts it was told,
decisions made last week. You give an agent one or more named **memory
slots**; each slot stores short text items through a provider and is keyed by
a **scope** (one memory for everybody, one per session, or one per user).

For each slot, `createAgent({ memory })`:

1. **Recalls** at the start of every run (`send()`, `stream()`, each session
   turn): on the run's first model call, the newest items go into the system
   prompt in a `<memory name="...">` block. The block stays for the rest of
   the run. A session's stored transcript (`session.messages`) does not keep
   it, but the run's own transcript does: `result.messages` of `send()` /
   `stream()`, and the run's checkpoints (a run continued after an approval
   recalls from them), contain the system message with the recalled items. Do
   not log or export those as if they held no memory.
2. Gives the model a **`remember_<name>`** tool (input `{ text }`, or your own
   `itemSchema`) to store a new item, and a **`recall_<name>`** tool (input
   `{ query?, limit? }`, `limit` capped at 100) to search the slot, newest items first.
   Each returned item has its `id`, `text` and `createdAt`, plus `score` from a
   vector provider and, on a slot without `itemSchema`, its other `metadata`.
   The `remember_<name>` description tells the model how long items last: in
   later conversations (`'global'`), later in this conversation (`'session'`),
   or in later conversations with the same user or key (a scope function).
   Memory tags inside item text are escaped (`&lt;memory`, `&lt;/memory`) so
   an item cannot open or close a block.

## Memory in code

The `vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts no-run
import { createAgent, defineMemory, fileMemory } from '@lousho/build-ai-agent';

const preferences = defineMemory({
  name: 'preferences',
  description: "the user's preferences: language, tone, tools they like",
  scope: 'session',
  provider: fileMemory({ dir: './.lousho/memory' }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a helpful assistant. Save lasting preferences with remember_preferences.',
  memory: [preferences],
});

await agent.session({ id: 'user-42' }).send('Please always answer in French.');
// Later, in a new conversation with the same id, the preference is in the system prompt:
const { text } = await agent.session({ id: 'user-42' }).send('What is the capital of Japan?');
```

The system prompt of the second conversation ends with:

```text
<memory name="preferences">
- The user wants answers in French.
</memory>
```

## Scopes

A run reads and writes the items of its **scope key**. In the provider, items
live under **`<slot name>#<scope key>`** (`notes#global`, `prefs#session:s1`),
so two slots that resolve to the same scope keep separate lists — you can share
one provider (and one `SqliteStore`) across slots safely. `memoryKey(slot, ctx)`
returns that key for a run context (or `undefined` when the slot is off); use it
when you seed, read or prune a slot's items from code.

| `scope` | Scope key | One memory per |
|---|---|---|
| `'global'` | `'global'` | agent (shared by every run) |
| `'session'` | `'session:<id>'`: the `agent.session({ id })` id, or `send()` / `stream()`'s `sessionId` (which needs a `store` with checkpoints) | session |
| `({ sessionId, metadata }) => string \| undefined` | what the function returns | whatever you key by, e.g. a user |

A scope function sees the run's `sessionId` and the `metadata` passed to
`send()` / `stream()`, so you can keep one memory per user across all their
sessions:

```ts
import { createAgent, defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const userFacts = defineMemory({
  name: 'user_facts',
  scope: ({ metadata }) => (typeof metadata?.userId === 'string' ? `user:${metadata.userId}` : undefined),
  provider: inMemoryMemory(),
});

const agent = createAgent({ provider: mockModel(['Hello!']), memory: [userFacts] });
await agent.send('Hi again!', { metadata: { userId: 'u-42' } });
```

When a run has no scope key (a `'session'` slot in a `send()` without a
`sessionId`, or a scope function that returns `undefined` or `null`), the slot is off
for that run: nothing is recalled and its tools are not offered.

A scope function must return a non-empty string (or `undefined` / `null`).
Anything else fails the run with `LOUSHO_MEMORY_INVALID` naming the slot,
because it would otherwise put every caller's items under one shared key: a
number or an object, an empty string, or a key built from a missing value such
as `user:undefined`, `user:null` or `user:[object Object]`. A scope function
that throws fails the run with the same code. `defineMemory()` rejects a
`scope` that is not `'global'`, `'session'` or a function.

A scope function also sees `principal`, the caller a route's auth verified, which
is safer to key on than `metadata` (the caller can send any metadata): see
[Route auth and principals](./auth.md#reading-the-principal-in-the-run).

## Configuration options

`defineMemory(options)` returns a `MemorySlot`:

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | 1-55 characters of `A-Za-z0-9_-`; the tools are `remember_<name>` and `recall_<name>`. Unique per agent. |
| `description` | `string` | none | What the slot holds; added to the tool descriptions. |
| `scope` | `'global' \| 'session' \| (ctx) => string \| undefined` | required | See [Scopes](#scopes). |
| `provider` | `MemoryProvider` | required | Where items are stored: `inMemoryMemory()`, `fileMemory({ dir })`, or your own. |
| `recall.onSessionStart` | `boolean` | `true` | Recall into the system prompt on each run's first model call. |
| `recall.maxItems` | `number` | `10` | Most items recalled into the prompt, and the default `limit` of `recall_<name>`. |
| `recall.query` | `'last-input' \| 'none'` | `'none'` | `'last-input'` passes the run's last user message to the provider as `query`, to recall relevant items rather than the newest. |
| `expose.remember` | `boolean` | `true` | Offer the `remember_<name>` tool. |
| `expose.recall` | `boolean` | `true` | Offer the `recall_<name>` tool. |
| `itemSchema` | a zod or Standard Schema | `{ text: string }` | `remember_<name>`'s input. When set, the parsed arguments are the item: `text` is their canonical JSON and `metadata` is the parsed object, so the slot enforces structured state instead of free text. |

```ts
import { z } from 'zod';
import { defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';

const relationship = defineMemory({
  name: 'relationship',
  scope: 'global',
  provider: inMemoryMemory(),
  itemSchema: z.object({ trust: z.number(), mood: z.string(), insideJokes: z.array(z.string()) }),
});
// remember_relationship now takes { trust, mood, insideJokes }; recall returns e.g. {"insideJokes":[],"mood":"playful","trust":10}
```

A slot with `expose: { remember: false }` is read-only for the model: you
fill it from code with `provider.add(memoryKey(slot)!, { text })`. For a
`'session'` or function scope, pass the run's context:
`memoryKey(slot, { sessionId, metadata })`. Without it `memoryKey()` returns
`undefined`, and the built-in providers reject a missing or empty scope key
with `LOUSHO_MEMORY_INVALID` instead of storing items under the key `undefined`.

### When recall fails

Recall at the start of a run does not fail the run. If the provider throws (a
corrupt memory file, a database or KV outage), the run goes on without that
slot's `<memory>` block, and a `console.warn` names the slot (once per slot
per process). A `recall_<name>` call that fails returns the error to the model
as a tool error.

## Providers

| Provider | Storage |
|---|---|
| `inMemoryMemory({ maxItems? })` | This process; lost on restart. For tests and demos. |
| `fileMemory({ dir, maxItems? })` | One JSON file per scope key in `dir` (key URI-encoded, each uppercase letter written as `^` and the lowercase letter, so `user:Alice` and `user:alice` get different files on Windows and macOS too), written atomically. |
| `kvMemory({ binding?, maxItems? })` | A Cloudflare Workers KV namespace — the `AGENT_CHECKPOINTS` binding, or the one `binding` names — for `memory/` files of a cloudflare-worker agent directory; bound to `env` per request. See [Cloudflare Workers](cloudflare-workers.md#build-and-deploy). |
| `sqliteMemory(store, { maxItems? })` (from `/sqlite`) | A `memory_items` table in the agent's `SqliteStore` file, one JSON array per scope key. |
| `inMemoryVectorMemory({ embedder, maxItems?, minScore? })` | This process; recalls by meaning. See [Semantic recall](#semantic-recall). |
| `sqliteVectorMemory(store, { embedder, maxItems?, minScore? })` (from `/sqlite`) | A `memory_vectors` table in the agent's `SqliteStore` file; recalls by meaning. |

The first three keep at most `maxItems` items per scope key (default 1000;
adding one more drops the oldest) and match a `query` by keyword: an item matches when it
shares a whole word with the query, ignoring case and a plural `s` (`cat` finds
"has two cats" but not "education"). Only the query's words of three or more
letters count, unless it has none (`"AI"`). Items matching more of the query's
words come first, then the newest. A query that shares no word with any item
returns nothing. Keyword matching does not know synonyms: to recall by meaning,
use a [vector provider](#semantic-recall).
Every built-in provider dedupes on `text`: adding an item whose text is
already stored returns the stored item instead of a duplicate (so an agent
that remembers the same fact twice keeps one copy).

### SQLite

Pass the same `SqliteStore` to the agent and to the provider, and sessions,
checkpoints and memory share one database file. An existing file gains the
table when it is opened. Keep the store open while the agent runs. To recall
by meaning instead of by keyword, use `sqliteVectorMemory()`: see
[Semantic recall](#semantic-recall).

```ts no-run
import { createAgent, defineMemory } from '@lousho/build-ai-agent';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db');
const notes = defineMemory({ name: 'notes', scope: 'global', provider: sqliteMemory(store) });
const agent = createAgent({ model: 'openai/gpt-4o-mini', store, memory: [notes] });
```

For a hosted store or your own ranking, implement `MemoryProvider`:

```ts
import type { MemoryItem, MemoryProvider } from '@lousho/build-ai-agent';

const items = new Map<string, MemoryItem[]>();
const myProvider: MemoryProvider = {
  async list(scopeKey, { limit, query } = {}) {
    // Newest first; use `query` to rank (e.g. by embedding similarity).
    return (items.get(scopeKey) ?? []).slice(0, limit);
  },
  async add(scopeKey, { text, metadata }) {
    const item: MemoryItem = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), metadata };
    items.set(scopeKey, [item, ...(items.get(scopeKey) ?? [])]);
    return item;
  },
  async remove(scopeKey, id) {
    items.set(scopeKey, (items.get(scopeKey) ?? []).filter((item) => item.id !== id));
  },
};
```

## Testing memory

With [`mockModel`](./testing.md), assert on the system prompt of the first
request and drive the tools with scripted tool calls:

```ts
import { createAgent, defineMemory, inMemoryMemory, memoryKey } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const store = inMemoryMemory();
const notes = defineMemory({ name: 'notes', scope: 'global', provider: store });
await store.add(memoryKey(notes)!, { text: 'The user likes tea.' });

const model = mockModel([{ toolCalls: [{ name: 'remember_notes', args: { text: 'Lives in Oslo.' } }] }, 'Noted.']);
await createAgent({ provider: model, memory: [notes] }).send('I moved to Oslo.');

console.log(model.calls[0].messages[0].content); // ends with <memory name="notes">\n- The user likes tea.\n</memory>
console.log((await store.list(memoryKey(notes)!)).map((item) => item.text)); // ['Lives in Oslo.', 'The user likes tea.']
```

## Limitations

- Recall and the memory tools apply to the agent's own runs, not to its
  sub-agents. A [handoff](./handoffs.md#what-switches-and-what-stays) target
  keeps the lead's memory (the recalled blocks and the tools, under the same
  scope keys); a target's own `memory` slots are not used. When `agent.approvals.resolve()` continues a run after an
  approval pause, the recalled block stays in the prompt but the memory tools
  are not offered for the rest of that run.
- An agent directory's `memory/` folder is part of the agent: see
  [Agent directories](./agent-directories.md#memory).

## Semantic recall

The keyword providers above find an item only when it shares a word with the
query. A vector provider finds it by meaning: it turns every item and every
query into a vector with an embedding model and ranks the items by cosine
similarity, so "what does the user like to eat?" finds "Sam is vegetarian".

An **embedder** (`EmbeddingProvider`) turns texts into vectors.
`aiSdkEmbedder(model)` wraps any AI SDK embedding model, through `embedMany`
from the installed `ai` package (4, 6 or 7; build the model with the provider
package that pairs with your `ai` major, as for language models). It adds no
dependency: `ai` is already a peer, and the provider package is yours.

```ts no-run
import { createAgent, defineMemory, aiSdkEmbedder, inMemoryVectorMemory } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const facts = defineMemory({
  name: 'facts',
  scope: 'global',
  provider: inMemoryVectorMemory({
    embedder: aiSdkEmbedder(openai.embedding('text-embedding-3-small')),
    minScore: 0.3,
  }),
  recall: { query: 'last-input' },
});
const agent = createAgent({ model: 'openai/gpt-4o-mini', memory: [facts] });
```

Two providers rank by meaning, with the same options:

- `inMemoryVectorMemory({ embedder, maxItems?, minScore? })` keeps items in this
  process.
- `sqliteVectorMemory(store, { embedder, maxItems?, minScore? })` (from
  `@lousho/build-ai-agent/sqlite`) keeps them in the agent's SQLite file, in a
  `memory_vectors` table that an existing file gains when it is opened. Vectors
  survive restarts.

With a query, `list()` embeds it, scores the items of that scope key, drops
those under `minScore` (cosine similarity, default `0.2`), sorts by score
(newer first on a tie) and returns `limit` of them. Each returned item has its
score in `metadata.score`. Without a query, or a blank one, it lists the newest
items first, like every provider. The `recall_<name>` tool then reads "Search
the "<name>" memory by meaning, most relevant first."

To recall by meaning at the start of a run, set `recall: { query: 'last-input' }`
on the slot: the run's last user message is the query, so the `<memory>` block
holds the items closest to it instead of the newest ones. Without it, the block
holds the newest `maxItems` items and only the `recall_<name>` tool ranks.

Items are only ever compared within their own scope key, and only when the same
embedder (its `id`) made them. The id is stored with each vector: after you
change the model or the id, old items are skipped when ranking (they still show
in listings without a query) until you call `await provider.reindex()`, which
re-embeds them in batches and returns how many it changed.
`reindex(providerKey)` does one key only — for a slot's key, pass
`memoryKey(slot, ctx)`.

`hashEmbedder()` from `@lousho/build-ai-agent/testing` is a deterministic
offline embedder for tests: a hashed bag of word stems, so texts that share
words are close. It is not a semantic model and does not know that "vegetarian"
and "eat" are related.

```ts
import { inMemoryVectorMemory } from '@lousho/build-ai-agent';
import { hashEmbedder } from '@lousho/build-ai-agent/testing';

const memory = inMemoryVectorMemory({ embedder: hashEmbedder() });
await memory.add('global', { text: 'Sam is vegetarian' });
await memory.add('global', { text: 'The office is in Oslo' });

const [best] = await memory.list('global', { query: 'vegetarian food' });
console.log(best.text, best.metadata?.score); // Sam is vegetarian, a score of about 0.5
```

Costs and limits:

- Every `add` makes one embedding call and every query makes one, so memory
  writes and recall cost model calls and add latency. A failed embedding call
  stores nothing; the `remember_<name>` tool reports the error to the model.
- Scoring is brute force in JavaScript over one scope key's items, with no vector
  index. Keep `maxItems` (default 5000 per scope key; adding one more drops the
  oldest) in mind: thousands of items per key are fine, hundreds of thousands are not.
- `fileMemory()`, `sqliteMemory()` and the Cloudflare KV store have no vector
  support. Write your own `MemoryProvider` for a vector database.
