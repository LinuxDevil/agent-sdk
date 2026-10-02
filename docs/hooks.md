# Hooks

A hook is an object `{ name, preToolCall?, postToolCall?, preGenerate?, postGenerate? }` that runs inside the agent loop, around every tool call and every model call. Use one to write an audit log, deny a tool, redact or truncate a result, inject context before the model call, or change the request (a header, `temperature`) it sends.

Hooks are code you write, not policy and not a human decision: for rules that allow, deny or ask per tool, and for a person approving a call, use `permissions` and `needsApproval` ([Approvals](./approvals.md)). Listeners such as `onEvent` only watch a run and cannot change it ([Streaming](./streaming.md#listening-without-iterating)); a hook can.

## Your first hook

Pass hooks to `createAgent({ hooks })`. This one logs every tool call and what it returned:

```ts
import { createAgent, defineTool, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const auditHook: AgentHook = {
  name: 'audit',
  preToolCall(ctx) {
    console.log('calling', ctx.toolName, ctx.args);
  },
  postToolCall(ctx, result) {
    console.log('finished', ctx.toolName, result.error ?? 'ok');
  },
};

const lookup = defineTool({
  name: 'lookup',
  description: 'Look something up',
  input: z.object({ query: z.string() }),
  async execute({ query }) {
    return { answer: `result for ${query}` };
  },
});

const agent = createAgent({
  prompt: 'You answer questions.',
  provider: mockModel([{ toolCalls: [{ name: 'lookup', args: { query: 'hooks' } }] }, { text: 'Done.' }]),
  tools: [lookup],
  hooks: [auditHook],
});

await agent.send('Look up hooks');
```

Every method is optional: implement only the points you need. A hook that returns nothing only watches; mutating `ctx.args`, `ctx.messages` or `ctx.request` in place also changes the run.

## The four hook points

| Point | Fires | Context | May return |
| --- | --- | --- | --- |
| `preToolCall(ctx)` | Before a tool runs, ahead of permission rules, tool guardrails and the approval check. | `ToolCallHookContext`: `toolCallId`, `toolName`, `args` (live), `toolCall`, plus the common fields below. | Nothing, `{ deny }`, `{ result }` or `{ input }` (see [Hook outcomes](#hook-outcomes)). |
| `postToolCall(ctx, result)` | After a tool call settles: success, a tool-level error, or approval required. `result` is `{ result, error?, requiresApproval? }`. | `ToolCallHookContext`. | Nothing, or `{ result }` to replace what the model sees. |
| `preGenerate(ctx)` | Before each model call. | `GenerateHookContext`: `request` (the live `GenerateOptions` about to be sent) and `emit?`, plus the common fields. | Nothing; mutate `ctx.messages` or `ctx.request`, or throw. |
| `postGenerate(ctx, result)` | After each model call resolves, with its `GenerateResult`. | `GenerateHookContext`. | Nothing; or throw. |

The common fields on every context are `agentId`, `agentName`, `sessionId`, `messages` (the live conversation history), `metadata` (a free-form bag) and `subagent` (set inside a sub-agent). `ctx.emit` exists when the run has listeners (`createAgent({ onEvent })`, `onAgentEvent`) or is streamed, and adds `compaction.start` / `compaction.done` events to the run's events.

## Hook outcomes

A tool-call hook can change what happens, not just watch it. A `preToolCall`
hook may return:

- nothing: the call goes on unchanged (mutating `ctx.args` in place still works).
- `{ deny: reason }`: the call does not run. The model gets the same
  `kind: 'denied'` tool error a `needsApproval` deny produces (see
  [Approvals](./approvals.md#approve-deny-or-ask)), streams see `tool.error`,
  and `onPermissionDecision` records `decision: 'deny'` with `hook` and `reason`.
- `{ result: value }`: the call does not run and `value` is its result. The
  `tool.done` event and the transcript's `tool` message (`metadata`) carry
  `replacedByHook: '<hook name>'`.
- `{ input: args }`: the call runs with `args`. They are validated against
  the tool's input schema again; a mismatch becomes a `kind: 'validation'`
  tool error whose message names the hook, and the tool does not run.

A `postToolCall` hook may return `{ result: value }` to replace the result the
model sees (to redact or truncate it); nothing keeps it. Hooks run in
registration order: the first `deny` or `result` of a pre-hook skips the
pre-hooks after it, `input`s chain (each hook sees the previous one's as
`ctx.args`), and each post-hook sees the result an earlier one replaced. A hook
that throws still rejects the run, as before. Sub-agents inherit the lead
agent's hooks and their outcomes.

```ts
import { createAgent, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = mockModel(['Done.']);

const guard: AgentHook = {
  name: 'guard',
  preToolCall(ctx) {
    if (ctx.toolName === 'shell') return { deny: 'Use the workspace tools instead' };
    if (ctx.toolName === 'search') return { input: { ...ctx.args, limit: 10 } };
    return undefined; // continue unchanged
  },
  postToolCall(_ctx, result) {
    return typeof result.result === 'string' ? { result: result.result.slice(0, 2000) } : undefined;
  },
};

const agent = createAgent({ provider, instructions: 'You research things.', hooks: [guard] });
```

## Recipes

Each recipe is a complete program. They run against `mockModel`, so none of them needs an API key or a live model call; the same pattern tests your own hooks offline ([Testing](./testing.md)). Each one scripts a model turn that calls a tool, then a final answer.

### Deny a tool by name

```ts
import { createAgent, defineTool, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const shell = defineTool({
  name: 'shell',
  description: 'Run a shell command',
  input: z.object({ command: z.string() }),
  async execute({ command }) {
    return { ran: command };
  },
});

const noShell: AgentHook = {
  name: 'no-shell',
  preToolCall(ctx) {
    if (ctx.toolName === 'shell') return { deny: 'The shell is disabled here' };
    return undefined;
  },
};

const model = mockModel([{ toolCalls: [{ name: 'shell', args: { command: 'ls' } }] }, { text: 'I could not run it.' }]);
const agent = createAgent({ prompt: 'You help.', provider: model, tools: [shell], hooks: [noShell] });

const result = await agent.send('List the files');
console.log(result.text);
```

### Add a default argument

Return `{ input }` to run the tool with different arguments. They are validated against the tool's schema again.

```ts
import { createAgent, defineTool, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const search = defineTool({
  name: 'search',
  description: 'Search the docs',
  input: z.object({ query: z.string(), limit: z.number().optional() }),
  async execute({ query, limit }) {
    return { query, limit };
  },
});

const defaultLimit: AgentHook = {
  name: 'default-limit',
  preToolCall(ctx) {
    if (ctx.toolName === 'search' && ctx.args.limit === undefined) {
      return { input: { ...ctx.args, limit: 5 } };
    }
    return undefined;
  },
};

const model = mockModel([{ toolCalls: [{ name: 'search', args: { query: 'hooks' } }] }, { text: 'Found it.' }]);
const agent = createAgent({ prompt: 'You search.', provider: model, tools: [search], hooks: [defaultLimit] });

await agent.send('Search for hooks');
```

### Truncate or redact a result

`postToolCall` receives the settled result and may return `{ result }` to replace what the model sees. The tool itself ran unchanged.

```ts
import { createAgent, defineTool, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const readLog = defineTool({
  name: 'read_log',
  description: 'Read the log',
  input: z.object({}),
  async execute() {
    return 'user=ada email=ada@example.com ' + 'x'.repeat(5000);
  },
});

const redact: AgentHook = {
  name: 'redact',
  postToolCall(_ctx, result) {
    if (typeof result.result !== 'string') return;
    const masked = result.result.replace(/[\w.]+@[\w.]+/g, '[email]');
    return { result: masked.slice(0, 1000) };
  },
};

const model = mockModel([{ toolCalls: [{ name: 'read_log', args: {} }] }, { text: 'Read it.' }]);
const agent = createAgent({ prompt: 'You read logs.', provider: model, tools: [readLog], hooks: [redact] });

await agent.send('Read the log');
const toolMessage = model.calls[1].messages.at(-1);
console.log(toolMessage?.role); // 'tool': its content is the redacted text
```

### Inject context before a model call

`preGenerate` sees the live `ctx.messages` and `ctx.request`. Push a message to add context, or change a request field.

```ts
import { createAgent, type AgentHook } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const addDate: AgentHook = {
  name: 'add-date',
  preGenerate(ctx) {
    ctx.messages.push({ role: 'system', content: `Today is ${new Date().toISOString().slice(0, 10)}.` });
    ctx.request.temperature = 0;
  },
};

const model = mockModel(['Noted.']);
const agent = createAgent({ prompt: 'You help.', provider: model, hooks: [addDate] });

await agent.send('Hello');
console.log(model.calls.length); // 1
```

## Order and interaction

For one tool call, the order is: argument validation, `preToolCall` hooks,
permission rules (`permissions`), tool guardrails, the tool's `needsApproval`,
the approval pause, execution, `postToolCall` hooks. Hooks run before every
approval decision, so rules, `needsApproval` and the human all see (and approve)
the input a hook produced; the pending approval's `args` show it. When an
approved call is resumed, the pre-hooks run again: they may still deny it or
supply its result, but an `{ input }` that differs from the approved input is
refused with a tool error instead of running. See [Approvals](./approvals.md) for the pause and the resume.

- **Several hooks** run in the order of the `hooks` array, one at a time: each is awaited before the next, so a later hook sees what an earlier one changed.
- **A hook that throws** still rejects the run. Hooks are trusted code: the error is not turned into a tool result for the model.
- **Compaction.** `createAgent({ hooks })` runs your hooks first and the compaction hook after them, so compaction sees what they added ([Context compaction](./compaction.md)).
- **Sub-agents** inherit the lead agent's hooks. `ctx.subagent` is set when a hook runs inside one, so a hook can return early to see only the top-level run ([Hooks inside sub-agents](./sub-agents.md#hooks-inside-sub-agents)).

## HookRegistry

`createAgent({ hooks })` takes a plain array. Code that uses the executor API ([The executor API](./executor-api.md)) passes a `HookRegistry`: an ordered collection with `register`, `registerMany`, `get`, `has`, `list`, `unregister`, `clear` and `size`. Registering a second hook with the same `name` replaces the first and logs a warning.

```ts
import { HookRegistry, type AgentHook } from '@lousho/build-ai-agent/hooks';

const redactPii: AgentHook = {
  name: 'redact-pii',
  async preToolCall(ctx) {
    // mutate ctx.args, or throw to abort the tool call before it runs
  },
};

const hooks = new HookRegistry();
hooks.register(redactPii);
console.log(hooks.list().map((hook) => hook.name)); // [ 'redact-pii' ]
```

`HookRegistry`, `AgentHook` and the context types are available from the package root and from the `@lousho/build-ai-agent/hooks` subpath. Hooks authored in the Agent Forge canvas editor are compiled into a `HookRegistry` and run sandboxed rather than in the host process: see [Agent Forge](./agent-forge.md#hooks).
