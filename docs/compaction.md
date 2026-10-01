# Context compaction

A long agent run fills its context window mostly with tool results: file
contents, search hits, API responses the model read once and no longer needs
in full. Compaction keeps such a run under the model's limit in two phases:
first it replaces old tool results with a short marker, and if that is not
enough it replaces the oldest turns with a summary written by a (cheaper)
model.

## Compacting an agent

With `createAgent()`, turn compaction on with the `compaction` option. `true`
installs the hook with its defaults (prune old tool results above 90% of the
model's window); an object configures it, and `summarizer` selects
`twoPhaseStrategy()` with that model (a `"provider/model"` string or an
`LLMProvider`):

```ts
import { createAgent } from '@loushy/build-ai-agent';

const simple = createAgent({ model: 'openai/gpt-4o', compaction: true });

const agent = createAgent({
  model: 'openai/gpt-4o',
  compaction: {
    thresholdPercent: 0.8, // compact above 80% of the context window (default 0.9)
    protectedTokens: 20_000, // never change the newest 20K tokens (default 40_000)
    summarizer: 'openai/gpt-4o-mini', // prune, then summarize if still too big
  },
});

for await (const event of agent.stream('Audit the repository.')) {
  if (event.type === 'compaction.done') console.log(`${event.tokensBefore} -> ${event.tokensAfter} tokens`);
}
```

The object takes `strategy`, `thresholdPercent`, `contextWindow` and
`protectedTokens` (as in the table below) and `summarizer`; combining
`summarizer` with `strategy` is a configuration error (pass
`twoPhaseStrategy({ model })` as the `strategy` instead). `createAgent({ hooks })`
takes any other `AgentHook`s, which run before the compaction hook, so
compaction sees what they added. Hooks and compaction apply to `send()`,
`stream()` and sessions.

### Stream events

`agent.stream()`, `session.stream()` and `AgentExecutor.stream()` report each
compaction as two events, inside the step and before the model call that
triggered it (see [Streaming](./streaming.md#event-schema-version-1)):

| `type` | Fields |
| --- | --- |
| `compaction.start` | `strategy`, `tokensBefore`, `contextWindow`, `thresholdTokens`, `trigger?: 'manual'` |
| `compaction.done` | `strategy`, `tokensBefore`, `tokensAfter`, `prunedToolCallIds`, `summary?: boolean`, `error?: { message }`, `trigger?: 'manual'` |

Every `compaction.start` is followed by exactly one `compaction.done`. When the
strategy could not shrink anything, `tokensAfter` equals `tokensBefore`; when it
failed (or the summarizer failed and the hook fell back to pruning), `error` is
set and the run continues. `summary` is `true` when old turns were replaced by
a summary (the text itself is not sent; use `onCompaction` for it). A
non-streaming `send()` emits no events. Hooks add their own events with
`ctx.emit?.(...)` on the `preGenerate` context, which exists only in streamed runs.

## Compacting a run

`createCompactionHook()` returns an `AgentHook` named `compaction`. Register it
and pass the registry to `AgentExecutor.execute()`. The recommended setup is
the two-phase strategy with a cheap summarizer model:

```ts
import { AgentExecutor, HookRegistry, createCompactionHook, twoPhaseStrategy } from '@loushy/build-ai-agent';

const hooks = new HookRegistry();
hooks.register(
  createCompactionHook({
    strategy: twoPhaseStrategy({ model: 'openai/gpt-4o-mini' }), // prune, then summarize if still too big
    thresholdPercent: 0.9, // compact above 90% of the context window (the default)
    protectedTokens: 40_000, // never change the newest 40K tokens (the default)
    onCompaction: ({ tokensBefore, tokensAfter, prunedToolCallIds, summary, error }) => {
      console.log(`compacted ${tokensBefore} -> ${tokensAfter} tokens (${prunedToolCallIds.length} results pruned)`);
      if (summary) console.log('summary:', summary);
      if (error) console.warn('summarizer failed, kept the pruned conversation:', error.message);
    },
  })
);

const result = await AgentExecutor.execute({ agent, input, provider, toolRegistry, hooks });
```

Before every model call the hook estimates the request's size with
`estimateTokens` (see [Models, tokens and cost](./api-overview.md#models-tokens-and-cost)).
When it is above `thresholdPercent` of the context window, the hook runs its
strategy (and waits for it, if it is async) and calls `onCompaction` with the
token counts, the pruned `toolCallId`s, the summary if there is one and the
strategy name.

| Option | Default | Meaning |
| --- | --- | --- |
| `thresholdPercent` | `0.9` | Compact when the estimated request is above this share of the context window. Must be in (0, 1]. |
| `contextWindow` | registry, else `128_000` | Context window in tokens. By default it is looked up for `request.model` with `getModelInfo()`; register your own models with `registerModel()`. |
| `protectedTokens` | `40_000` | The newest messages that fit in this many tokens are never changed. |
| `strategy` | `pruneToolResultsStrategy()` | How to compact (see below). `twoPhaseStrategy()` is recommended; it needs a summarizer model, so it is not the default. |
| `onCompaction` | none | Called after each compaction that changed the conversation or reported an `error`. |

Compaction never fails a run. If the strategy throws, or the summarizer call
fails, the run continues (with the pruned conversation, or unchanged) and
`onCompaction` receives the `error`.

The hook rewrites the run's transcript itself, not a copy: the request's
`messages` array is the run's message list, and the hook changes it in place.
A pruned result or a summary therefore stays in later steps, in checkpoints
(a resumed session does not bring the full history back) and in
`result.messages`, and it is not compacted again on the next step.
Compaction is lossy: if the model needs a pruned result again, it has to call
the tool again.

## Strategies

| Strategy | What it does |
| --- | --- |
| `pruneToolResultsStrategy()` | Replaces old tool results with a marker. No model call. |
| `summarizeStrategy({ model, ... })` | Replaces old turns with one summary message written by `model`. |
| `twoPhaseStrategy({ model, ... })` | Prunes first; summarizes only if the conversation is still above the threshold. Recommended. |

### Pruning tool results

`pruneToolResultsStrategy()` replaces the `content` of each tool result older
than the protected tail with a marker such as
`[pruned: search result, 18234 chars]`. It never changes:

- system messages, user messages (the first one included) or assistant turns,
  so every tool call keeps its result message and the transcript stays valid
  for every provider;
- the results of the latest assistant turn, which the model has not read yet,
  even when they are bigger than `protectedTokens`;
- pinned results, results that are already a marker, or results shorter than
  a marker.

### Summarizing old turns

`summarizeStrategy()` sends the messages before the protected tail to the
summarizer with a focused instruction and replaces them with one `user`
message:

```text
[Conversation summary]
<the summary>
```

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | required | The summarizer: an `LLMProvider`, or a `"provider/model"` spec resolved with `resolveProvider()`. A small, cheap model is usually enough. |
| `protectedTokens` | the hook's | Recent tokens kept as they are. |
| `prompt` | `DEFAULT_SUMMARY_PROMPT` | The instruction sent as the summarizer's system message. The conversation to summarize is the user message. |
| `maxSummaryTokens` | provider default | `maxTokens` of the summary call. |

The summary keeps the transcript valid for every provider:

- system messages and pinned messages stay where they are, and the summary
  goes where the first summarized message was;
- an assistant turn is summarized or kept together with all its tool results,
  so no tool call loses its result (and no result loses its call);
- the last message and the latest assistant turn's results are always kept.

If the summary call fails (or returns nothing), the strategy falls back to
pruning and returns the failure as `error`.

### Two phases

`twoPhaseStrategy()` takes the same options. It prunes tool results first,
which is free, and calls the summarizer only when the pruned conversation is
still above `thresholdPercent` of the context window. The summarizer then
reads the pruned conversation. If it fails, the pruned conversation is kept and
`error` is reported.

## Pinning messages

`pinMessage(message)` returns a copy of the message marked as pinned (it sets
`metadata.pinned: true`; `Message.metadata` is application data that is never
sent to the model). The built-in strategies never prune or summarize a pinned
message; a pinned tool result keeps its whole assistant turn. Pin what the
agent must always see in full, such as the task statement or a key document:

```ts
import { pinMessage, isPinned, type Message } from '@loushy/build-ai-agent';

const messages: Message[] = [
  { role: 'system', content: 'You are a research assistant.' },
  pinMessage({ role: 'user', content: 'Goal: compare the three vendors on price and support.' }),
];
console.log(isPinned(messages[1])); // true
```

Custom strategies should honor `isPinned()` too.

## Compacting by hand

`compactMessages(messages, options)` runs a strategy once, whatever the size
of the conversation, and resolves to a new array (its input is not modified).
Use it to shrink a stored transcript before you continue it:

```ts
import { compactMessages, summarizeStrategy, type Message } from '@loushy/build-ai-agent';

declare const history: Message[];

const { messages, tokensBefore, tokensAfter, prunedToolCallIds } = await compactMessages(history, {
  protectedTokens: 8_000,
  model: 'gpt-4o-mini', // for the context-window lookup and the token estimator
});
console.log(`${tokensBefore} -> ${tokensAfter} tokens, pruned ${prunedToolCallIds.length} results`);

const summarized = await compactMessages(history, {
  protectedTokens: 8_000,
  strategy: summarizeStrategy({ model: 'openai/gpt-4o-mini' }),
});
console.log(summarized.summary ?? summarized.error?.message);
```

## Compacting a session

`session.compact(options?)` compacts a [session](./sessions.md)'s transcript
now, whatever its size, saves it to the session's store (memory, file, SQLite
or KV) and resolves to `{ messagesBefore, messagesAfter, tokensBefore, tokensAfter, strategy, error? }`.
It runs `options.strategy`, else the strategy of `agent.session({ compaction })`
(the same value as `createAgent({ compaction })`), else prunes old tool results.
Pinned messages stay. A session with no messages resolves without doing
anything. It rejects with `LOUSHY_SESSION_BUSY` while a turn is running, and
with `LOUSHY_SESSION_TURN_PENDING` / `LOUSHY_SESSION_AWAITING_APPROVAL` while a
durable turn is unfinished. Listeners added with `session.on()` get
`compaction.start` and `compaction.done` with `trigger: 'manual'`.
`session.clear()` empties the transcript instead and emits `context.cleared`.

```ts
import { createAgent, twoPhaseStrategy } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel(['ok']) });
const session = agent.session({ compaction: { strategy: twoPhaseStrategy({ model: 'openai/gpt-4o-mini' }) } });
session.on((event) => {
  if (event.type === 'compaction.done') console.log(event.trigger, event.tokensBefore, '->', event.tokensAfter);
});
await session.send('hello');
const { tokensBefore, tokensAfter } = await session.compact({ protectedTokens: 2_000 });
console.log(`${tokensBefore} -> ${tokensAfter} tokens`);
await session.clear();
console.log(session.messages.length); // 0
```

## Writing a strategy

A strategy is a name and a `compact()` function, which may be async. It
receives the messages, a token counter for the request's model, the context
window, `protectedTokens`, `thresholdTokens` (the size to get under) and the
run's abort `signal`, and returns the new messages with before/after token
counts (and optionally a `summary` or an `error`). Return the input array
unchanged when there is nothing to do: the hook then leaves the run alone and
does not call `onCompaction`.

```ts
import { createCompactionHook, isPinned, type CompactionStrategy } from '@loushy/build-ai-agent';

// Keep the system prompt, pinned messages and the last 20 messages.
const keepRecent: CompactionStrategy = {
  name: 'keep-recent',
  compact({ messages, estimateTokens }) {
    const tokensBefore = estimateTokens(messages);
    if (messages.length <= 22) return { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds: [] };
    // A real strategy must not split a tool call from its result.
    const older = messages.slice(0, -20).filter((m) => m.role === 'system' || isPinned(m));
    const kept = [...older, ...messages.slice(-20)];
    return { messages: kept, tokensBefore, tokensAfter: estimateTokens(kept), prunedToolCallIds: [] };
  },
};

const hook = createCompactionHook({ strategy: keepRecent });
```

A custom strategy gets the same `compaction.start` / `compaction.done` events as
the built-in ones. `onCompaction` (on `createCompactionHook()`) still receives
the summary text and the `Error`.
