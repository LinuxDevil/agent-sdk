# Svelte

`loushyAgent()` for Svelte is the [React hook](./react.md) as a store: the same
sources, the same state and the same actions, over the same
[typed event stream](./streaming.md). Read [React](./react.md) for what each
field means, the two kinds of source, how approvals work and the server side;
this page covers what differs.

It lives in the `@loushy/build-ai-agent/svelte` subpath. The store implements
Svelte's store contract (`subscribe(run) => unsubscribe`) by hand, so it works
with `$agent` in Svelte 4 and 5 and needs no `svelte` import: there is no peer
dependency to install.

```ts
import { loushyAgent } from '@loushy/build-ai-agent/svelte';

// In a component's <script lang="ts">, or a module that several components share:
export const agent = loushyAgent({ url: '/api/agent' }, { approvalsUrl: '/api/approvals' });

export async function submit(text: string): Promise<void> {
  if (text.trim()) await agent.send(text);
}
```

and in the component (a Svelte template, so not type-checked with the other
snippets here):

```html
{#each $agent.messages as message (message.id)}
  <article>
    <header>{message.role}</header>
    <p>{message.text}</p>
    {#each message.toolCalls ?? [] as call (call.id)}
      <code>{call.name}: {call.status}</code>
    {/each}
  </article>
{/each}
{#if $agent.pendingApproval}
  <p>
    Run {$agent.pendingApproval.toolName}?
    <button on:click={() => agent.approve()}>Approve</button>
    <button on:click={() => agent.reject('Not now')}>Reject</button>
  </p>
{/if}
{#if $agent.status === 'streaming'}<button on:click={agent.stop}>Stop</button>{/if}
```

## What differs from React

- **State is the store value.** `$agent` is the React hook's state object:
  `messages`, `status`, `pendingApproval`, `error`, `usage` and `lastEvent`.
  The commands (`send`, `stop`, `approve`, `reject`, `answer`) sit on the
  store itself with the React hook's signatures; they do not need a
  subscriber.
- **`reset()`** aborts the run in flight, forgets the in-process session
  (`{ agent, sessionId }` starts a new conversation) and clears the state.
- **The source and options are plain values**, read when a turn starts. To use
  another agent or `url`, create another store.
- **Cleanup is unsubscribing.** `stop()` aborts the request in flight, and so
  does the last subscriber going away (the component using `$agent` is
  destroyed). There is no `destroy()`: this is how Svelte stores stop their
  work. A store nobody subscribes to still runs a turn you started with
  `send()`; call `stop()` yourself if you drop it.

The reducer and the stream parser are exported from this subpath too
(`reduceAgentEvents`, `initialAgentUIState`, `parseEventStream`), the same
ones as in `@loushy/build-ai-agent/react`.
