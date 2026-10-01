# Context compaction

A long agent run fills its context window mostly with tool results: file
contents, search hits, API responses the model read once and no longer needs
in full. Compaction keeps such a run under the model's limit by replacing old
tool results with a short marker before the request is sent.

## Pruning old tool results in a run

`createCompactionHook()` returns an `AgentHook` named `compaction`. Register it
and pass the registry to `AgentExecutor.execute()`:

```ts
import { AgentExecutor, HookRegistry, createCompactionHook } from '@loushy/build-ai-agent';

const hooks = new HookRegistry();
hooks.register(
  createCompactionHook({
    thresholdPercent: 0.9, // compact above 90% of the context window (the default)
    protectedTokens: 40_000, // never prune the newest 40K tokens (the default)
    onCompaction: ({ tokensBefore, tokensAfter, prunedToolCallIds }) =>
      console.log(`compacted ${tokensBefore} -> ${tokensAfter} tokens (${prunedToolCallIds.length} results)`),
  })
);

const result = await AgentExecutor.execute({ agent, input, provider, toolRegistry, hooks });
```

Before every model call the hook estimates the request's size with
`estimateTokens` (see [Models, tokens and cost](./api-overview.md#models-tokens-and-cost)).
When it is above `thresholdPercent` of the context window, the hook runs its
strategy and calls `onCompaction` with the token counts, the pruned
`toolCallId`s and the strategy name.

| Option | Default | Meaning |
| --- | --- | --- |
| `thresholdPercent` | `0.9` | Compact when the estimated request is above this share of the context window. Must be in (0, 1]. |
| `contextWindow` | registry, else `128_000` | Context window in tokens. By default it is looked up for `request.model` with `getModelInfo()`; register your own models with `registerModel()`. |
| `protectedTokens` | `40_000` | The newest messages that fit in this many tokens are never changed. |
| `strategy` | `pruneToolResultsStrategy()` | How to compact (see below). |
| `onCompaction` | none | Called after each compaction that changed the conversation. |

## What pruning changes

`pruneToolResultsStrategy()` replaces the `content` of each tool result older
than the protected tail with a marker such as
`[pruned: search result, 18234 chars]`. It never changes:

- system messages, user messages (the first one included) or assistant turns,
  so every tool call keeps its result message and the transcript stays valid
  for every provider;
- the results of the latest assistant turn, which the model has not read yet,
  even when they are bigger than `protectedTokens`;
- results that are already a marker, or shorter than one.

The hook rewrites the run's transcript itself, not a copy: the request's
`messages` array is the run's message list, and the hook changes it in place.
A pruned result therefore stays pruned in later steps, in checkpoints (a
resumed session does not bring the full result back) and in
`result.messages`, and it is not pruned again on the next step. Pruning is
lossy: if the model needs a pruned result again, it has to call the tool
again.

## Compacting by hand

`compactMessages(messages, options)` runs a strategy once, whatever the size
of the conversation, and returns a new array (its input is not modified). Use
it to shrink a stored transcript before you continue it:

```ts
import { compactMessages, type Message } from '@loushy/build-ai-agent';

declare const history: Message[];

const { messages, tokensBefore, tokensAfter, prunedToolCallIds } = compactMessages(history, {
  protectedTokens: 8_000,
  model: 'gpt-4o-mini', // for the context-window lookup and the token estimator
});
console.log(`${tokensBefore} -> ${tokensAfter} tokens, pruned ${prunedToolCallIds.length} results`);
```

## Writing a strategy

A strategy is a name and a `compact()` function. It receives the messages, a
token counter for the request's model, the context window and
`protectedTokens`, and returns the new messages with before/after token counts.
Return the input array unchanged when there is nothing to do: the hook then
leaves the run alone and does not call `onCompaction`.

```ts
import { createCompactionHook, type CompactionStrategy } from '@loushy/build-ai-agent';

// Keep the system prompt, the first user message and the last 20 messages.
const keepRecent: CompactionStrategy = {
  name: 'keep-recent',
  compact({ messages, estimateTokens }) {
    const tokensBefore = estimateTokens(messages);
    if (messages.length <= 22) return { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds: [] };
    // A real strategy must not split a tool call from its result.
    const kept = [...messages.slice(0, 2), ...messages.slice(-20)];
    return { messages: kept, tokensBefore, tokensAfter: estimateTokens(kept), prunedToolCallIds: [] };
  },
};

const hook = createCompactionHook({ strategy: keepRecent });
```

A summarizing strategy (replace old turns with a model-written summary) and
typed `compaction.*` stream events are planned; `onCompaction` is where they
will plug in.
