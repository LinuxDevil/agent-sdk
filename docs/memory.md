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
   the run and is not saved in the session transcript.
2. Gives the model a **`remember_<name>`** tool (input `{ text }`) to store a
   new item, and a **`recall_<name>`** tool (input `{ query?, limit? }`) to
   search the slot, newest items first.

## Memory in code

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

A run reads and writes the items of its **scope key**:

| `scope` | Scope key | One memory per |
|---|---|---|
| `'global'` | `'global'` | agent (shared by every run) |
| `'session'` | `'session:<id>'`: the `agent.session({ id })` id, or `send()` / `stream()`'s `sessionId` | session |
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
`sessionId`, or a scope function that returns `undefined`), the slot is off
for that run: nothing is recalled and its tools are not offered.

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

A slot with `expose: { remember: false }` is read-only for the model: you
fill it from code with `provider.add(scopeKey, { text })`.

## Providers

| Provider | Storage |
|---|---|
| `inMemoryMemory({ maxItems? })` | This process; lost on restart. For tests and demos. |
| `fileMemory({ dir, maxItems? })` | One JSON file per scope key in `dir` (key URI-encoded), written atomically. |
| `sqliteMemory(store, { maxItems? })` (from `/sqlite`) | A `memory_items` table in the agent's `SqliteStore` file, one JSON array per scope key. |

All keep at most `maxItems` items per scope key (default 1000; adding one
more drops the oldest) and match a `query` by keyword: an item matches when it
contains one of the query's words of three or more letters, ignoring case.

### SQLite

Pass the same `SqliteStore` to the agent and to the provider, and sessions,
checkpoints and memory share one database file. An existing file gains the
table when it is opened. Keep the store open while the agent runs.

```ts no-run
import { createAgent, defineMemory } from '@lousho/build-ai-agent';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db');
const notes = defineMemory({ name: 'notes', scope: 'global', provider: sqliteMemory(store) });
const agent = createAgent({ model: 'openai/gpt-4o-mini', store, memory: [notes] });
```

For semantic search or a hosted store, implement `MemoryProvider`:

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
import { createAgent, defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const store = inMemoryMemory();
await store.add('global', { text: 'The user likes tea.' });
const notes = defineMemory({ name: 'notes', scope: 'global', provider: store });

const model = mockModel([{ toolCalls: [{ name: 'remember_notes', args: { text: 'Lives in Oslo.' } }] }, 'Noted.']);
await createAgent({ provider: model, memory: [notes] }).send('I moved to Oslo.');

console.log(model.calls[0].messages[0].content); // ends with <memory name="notes">\n- The user likes tea.\n</memory>
console.log((await store.list('global')).map((item) => item.text)); // ['Lives in Oslo.', 'The user likes tea.']
```

## Limitations

- Recall and the memory tools apply to the agent's own runs, not to its
  sub-agents. When `agent.approvals.resolve()` continues a run after an
  approval pause, the recalled block stays in the prompt but the memory tools
  are not offered for the rest of that run.
- An agent directory's `memory/` folder is part of the agent: see
  [Agent directories](./agent-directories.md#memory).
