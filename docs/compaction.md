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
`LLMProvider`). The `vendor/` model prefix chooses the provider; with
OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

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

The object takes `strategy`, `thresholdPercent`, `contextWindow`,
`protectedTokens`, `reserveOutputTokens` and `onCompaction` (as in the table below) and `summarizer`; combining
`summarizer` with `strategy` is a configuration error (pass
`twoPhaseStrategy({ model })` as the `strategy` instead). `createAgent({ hooks })`
takes any other `AgentHook`s, which run before the compaction hook, so
compaction sees what they added. Hooks and compaction apply to `send()`,
`stream()` and sessions.

### Stream events

`agent.stream()`, `session.stream()` and `AgentExecutor.stream()` report each
compaction as two events, inside the step and before the model call that
triggered it (see [Streaming](./stream-events.md#event-schema-version-1)):

| `type` | Fields |
| --- | --- |
| `compaction.start` | `strategy`, `tokensBefore`, `contextWindow`, `thresholdTokens`, `trigger?: 'manual'` |
| `compaction.done` | `strategy`, `appliedStrategy?`, `tokensBefore`, `tokensAfter`, `prunedToolCallIds`, `summary?: boolean`, `error?: { message }`, `trigger?: 'manual'` |

Every `compaction.start` is followed by exactly one `compaction.done`. When the
strategy could not shrink anything, `tokensAfter` equals `tokensBefore`; when it
failed (or the summarizer failed and the hook fell back to pruning), `error` is
set and the run continues. A summary that does not get the conversation under
the threshold - or that makes it larger - is rejected the same way: `error` is
set, the run keeps the pruned result instead, and `appliedStrategy` is
`'prune-tool-results'`. The hook then only prunes that transcript until it has
twice as many messages as at the rejection, and then lets the summarizer try
again, so a summarizer that cannot help costs a few calls per run, not one per
step, and one that was rejected for having too little to fold gets another
chance. `strategy` is the strategy that ran, the same on `compaction.start` and
`compaction.done` (`'prune-tool-results'` while summaries are paused).
`summary` is `true` when old turns were replaced by a summary (the text itself
is not sent; use `onCompaction`, which the object form also takes). A
`send()` without a listener emits no events. Hooks add their own events with
`ctx.emit?.(...)` on the `preGenerate` context, which exists when the run has
listeners (`createAgent({ onEvent })`, `onAgentEvent`) or is streamed.

## Compacting a run

`createCompactionHook()` returns an `AgentHook` named `compaction`. Pass it in
`createAgent({ hooks })`. The recommended setup is the two-phase strategy with
a cheap summarizer model:

```ts
import { createAgent, createCompactionHook, twoPhaseStrategy } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  hooks: [
    createCompactionHook({
      strategy: twoPhaseStrategy({ model: 'openai/gpt-4o-mini' }), // prune, then summarize if still too big
      thresholdPercent: 0.9, // compact above 90% of the context window (the default)
      protectedTokens: 40_000, // never change the newest 40K tokens (the default)
      onCompaction: ({ tokensBefore, tokensAfter, prunedToolCallIds, summary, error }) => {
        console.log(`compacted ${tokensBefore} -> ${tokensAfter} tokens (${prunedToolCallIds.length} results pruned)`);
        if (summary) console.log('summary:', summary);
        if (error) console.warn('summarizer failed, kept the pruned conversation:', error.message);
      },
    }),
  ],
});
```

Before every model call the hook estimates the request's size with
`estimateTokens` (see [Models, tokens and cost](./models-and-cost.md#models-and-the-price-table)):
the messages (the system prompt included), the tool definitions and the output
schema. After a call whose provider reported its prompt tokens, the hook also
adds what that report exceeded the estimate by to the next estimate of the same
run, so a provider's hidden framing is counted too. Tool definitions cannot be
compacted, so the conversation has to fit in what they leave of the threshold.
The `compaction.start` / `compaction.done` token counts are these request
sizes. When it is above `thresholdPercent` of the context window, the hook runs its
strategy (and waits for it, if it is async) and calls `onCompaction` with the
token counts, the pruned `toolCallId`s, the summary if there is one and the
strategy name.

| Option | Default | Meaning |
| --- | --- | --- |
| `thresholdPercent` | `0.9` | Compact when the estimated request is above this share of the context window. Must be in (0, 1]. |
| `contextWindow` | registry, else `128_000` | Context window in tokens. By default it is looked up for `request.model` with `getModelInfo()`; register your own models with `registerModel()`. The `128_000` fallback logs a one-time `console.warn` (see [Local and unknown models](#local-and-unknown-models)). |
| `reserveOutputTokens` | none | Tokens kept free for the reply: the threshold becomes at most `contextWindow - reserveOutputTokens`. It never raises the `thresholdPercent` threshold. |
| `protectedTokens` | `40_000` | The newest messages that fit in this many tokens are never changed. |
| `strategy` | `pruneToolResultsStrategy()` | How to compact (see below). `twoPhaseStrategy()` is recommended; it needs a summarizer model, so it is not the default. |
| `onCompaction` | none | Called after each compaction that changed the conversation or reported an `error`, with the token counts, the pruned `toolCallId`s, `strategy`, `appliedStrategy`, the summary text and the `error`. |

Compaction never fails a run. If the strategy throws, or the summarizer call
fails, the run continues (with the pruned conversation, or unchanged) and
`onCompaction` receives the `error`.

Inside a run, the summarizer's model call is part of the run: its tokens are in
`result.usage` (under the summarizer's model in `byModel`, and in
`modelCalls`), it gets a `chat` span with `lousho.call.purpose: 'compaction'`
under the run's span, and it counts toward the run's `limits` budgets.
(`session.compact()` and `compactMessages()` run outside a run, so their
summary calls are not counted anywhere.)

The hook rewrites the run's transcript itself, not a copy: the request's
`messages` array is the run's message list, and the hook changes it in place.
A pruned result or a summary therefore stays in later steps, in checkpoints
(a resumed session does not bring the full history back) and in
`result.messages`, and it is not compacted again on the next step.
Compaction is lossy: if the model needs a pruned result again, it has to call
the tool again.

### Local and unknown models

The threshold is a share of the model's context window, so compaction needs
the real window. For a model the [model registry](./models-and-cost.md#models-and-the-price-table)
does not know (most local models), the hook assumes `128_000` tokens and logs a
one-time `console.warn` naming the model. A local server usually runs with a
much smaller window, and then compaction never fires before the server rejects
the request. Set the window you loaded the model with: in LM Studio it is the
model's loaded context length (`loaded_context_length` from
`GET /api/v0/models/<id>`), in Ollama the `num_ctx` option (`ollama show <model>`
prints the model's default).

```ts
import { createAgent, registerModel } from '@lousho/build-ai-agent';

// Either on the agent...
const agent = createAgent({
  model: 'ollama/qwen3:8b',
  compaction: { contextWindow: 8_192, reserveOutputTokens: 1_024 },
});

// ...or once for every feature that reads the window (compaction, tool search).
registerModel({ id: 'qwen3:8b', provider: 'ollama', contextWindow: 8_192 });
```

[Tool search](./tool-search.md) reads the window the same way and warns the same
way; its own setting is `toolSearch.contextWindow`.

#### Advanced: the executor API

Registering the hook in a `HookRegistry` is for code that calls the executor
directly (see [the executor API](./executor-api.md)):

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { HookRegistry, createCompactionHook, twoPhaseStrategy } from '@lousho/build-ai-agent';

const hooks = new HookRegistry();
hooks.register(
  createCompactionHook({
    strategy: twoPhaseStrategy({ model: 'openai/gpt-4o-mini' }),
    thresholdPercent: 0.9,
    protectedTokens: 40_000,
  })
);

const result = await AgentExecutor.execute({ agent, input, provider, toolRegistry, hooks });
```

## Strategies

| Strategy | What it does |
| --- | --- |
| `pruneToolResultsStrategy()` | Replaces old tool results with a marker. No model call. |
| `summarizeStrategy({ model, ... })` | Replaces old turns with one summary message written by `model`. |
| `twoPhaseStrategy({ model, ... })` | Prunes first; summarizes only if the conversation is still above the threshold. Recommended. |

### Pruning tool results

`pruneToolResultsStrategy()` replaces the `content` of each tool result older
than the protected tail with a short stub that names the call, such as
`[pruned: search({"query":"deploy"}) result, 18234 chars; already read]`
(arguments longer than 120 characters are cut), so the model knows what it
already fetched and does not call the same tool again just to see the result.
Markers in the older `[pruned: search result, 18234 chars]` form are
recognized and left alone. It never changes:

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
import { pinMessage, isPinned, type Message } from '@lousho/build-ai-agent';

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
import { compactMessages, summarizeStrategy, type Message } from '@lousho/build-ai-agent';

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
(the same value as `createAgent({ compaction })`, and the agent's own
`compaction` when the session does not set one), else prunes old tool results.
Pinned messages stay. A session with no messages resolves without doing
anything. It rejects with `LOUSHO_SESSION_BUSY` while a turn is running, and
with `LOUSHO_SESSION_TURN_PENDING` / `LOUSHO_SESSION_AWAITING_APPROVAL` while a
durable turn is unfinished. Listeners added with `session.on()` get
`compaction.start` and `compaction.done` with `trigger: 'manual'`.
`session.clear()` empties the transcript instead and emits `context.cleared`.

```ts
import { createAgent, twoPhaseStrategy } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

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
import { createCompactionHook, isPinned, type CompactionStrategy } from '@lousho/build-ai-agent';

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
