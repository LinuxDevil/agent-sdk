# Code mode

With code mode the model gets one more tool, `run_code`. Instead of calling
tools one at a time, with a model round trip after each, it writes a short
JavaScript program that calls the agent's tools as async functions, loops,
filters and combines their results, and returns one value. Many tool calls then
cost one model round trip, and large intermediate results never enter the
context: only the program's return value does.

The program runs in a QuickJS WebAssembly isolate inside your process, not in
Docker. Every tool call it makes goes through the same checks as a call the
model makes directly: argument validation, hooks, permission rules and modes,
guardrails and `needsApproval`.

## When to use it

- The answer needs several calls whose inputs depend on earlier results (look
  up three prices, then convert the sum).
- A tool returns much more than the model needs (a long list to filter, a
  report to count).
- The same call runs over a list of items.

For a single call, or when each step needs the model's judgement, direct tool
calls are simpler and the model is better at them.

## Turn it on

Install the optional peer `quickjs-emscripten` and set `codeMode` on
`createAgent()`:

```bash
npm install quickjs-emscripten@^0.32.0
```

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const prices: Record<string, number> = { apple: 1.2, pear: 0.8, plum: 2 };

const getPrice = defineTool({
  name: 'get_price',
  description: 'The price of one fruit in USD',
  input: z.object({ item: z.string() }),
  execute: async ({ item }) => ({ item, usd: prices[item] ?? null }),
});

const convert = defineTool({
  name: 'convert',
  description: 'Converts an amount in USD to another currency',
  input: z.object({ amount: z.number(), to: z.enum(['EUR', 'GBP']) }),
  execute: async ({ amount, to }) => ({ amount: amount * (to === 'EUR' ? 0.9 : 0.8), currency: to }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  tools: [getPrice, convert],
  codeMode: { exclusive: true },
});

const { text } = await agent.send('What do an apple, a pear and a plum cost together in EUR?');
```

A script the model might write for that question:

```js
let usd = 0;
for (const item of ['apple', 'pear', 'plum']) {
  usd += (await tools.get_price({ item })).usd;
}
const eur = await tools.convert({ amount: usd, to: 'EUR' });
return { usd, eur: eur.amount };
```

`run_code` returns `{ result, logs, toolCalls }`: the script's return value,
the lines it logged with `console.log()` (and `console.error()` / `warn()`,
prefixed with their level) and how many tool calls it made.

Without `quickjs-emscripten` installed, the first run of an agent with
`codeMode` fails with a `MissingPeerDependencyError` that names the package and
the install command.

## Options

`codeMode: true` uses the defaults. An object sets any of these:

| Option | Default | Meaning |
| --- | --- | --- |
| `tools` | see below | Names of the tools a script may call. Names the run has no tool for are skipped. `run_code` itself is refused. |
| `exclusive` | `false` | `true` takes those tools off the model's tool list, so it must call them through `run_code`. Scripts still call them. |
| `timeoutMs` | `30000` | Time for the whole script, including the tool calls it waits for. |
| `memoryLimitBytes` | `67108864` (64 MiB) | Memory of the isolate. |
| `maxToolCalls` | `50` | Tool calls per script. |
| `maxOutputChars` | `20000` | Characters of the return value (as JSON) plus the logs. |

Without `tools`, a script may call every tool of the run except `run_code`,
`ask_question`, sub-agent tools (`task`, `agent_status`, `agent_await`,
`agent_cancel`, `delegate_to_*`), `tool_search`, `load_skill` and tools that
[tool search](./tool-search.md) defers. Name a tool in `tools` to allow it
anyway: a deferred tool named there is callable from scripts and its signature
is in `run_code`'s description (so it is no longer kept out of the context for
code mode), while it stays off the model's own tool list until `tool_search`
loads it.

The model learns what it can call from `run_code`'s description: one
TypeScript-like signature per allowed tool, built from its input schema, with
its description as a comment:

```text
// The price of one fruit in USD
tools.get_price(args: { item: string }): Promise<unknown>
```

Results have no declared type, so when a script fails, the error lists the
script's first five tool calls with their arguments and results (each cut at
200 characters). The model can read the shapes there and fix the script.

## What a script can and cannot do

The code is the body of an `async` function. It can use the JavaScript
language and its built-ins (`JSON`, `Math`, `Date`, `Promise`, arrays, maps,
regular expressions), call tools, log, and return a value.

- `await tools.<name>(args)` resolves with the tool's result, or throws an
  `Error` (`name: 'ToolError'`) whose message is the tool's error message.
  `tools` holds only the allowed tools and cannot be changed.
- Arguments and results cross the boundary as JSON copies: a `Date` arrives as
  a string, functions and `undefined` fields are dropped, and changing a result
  inside the script changes nothing outside it.
- `Promise.all` runs calls at the same time, at most `toolConcurrency` of them
  (the agent's setting) per script.
- The return value must be JSON-serializable; `undefined` becomes `null`.

There is no `require`, `import`, `process`, `fetch`, file system, network,
`setTimeout` or other timer, and no host object. A script can only reach the
outside world through the tools it is given.

## The security model

- **Isolation.** Each script gets a fresh QuickJS runtime and context in
  WebAssembly, with nothing of the host in it but two functions (one tool
  call, one log line) that the SDK's own setup code takes off the global object
  before the script runs. `node:vm` is not used: it is not a security boundary.
- **Limits.** The memory limit and a 512 KiB stack limit are enforced by the
  isolate. The deadline is checked by an interrupt handler while the script
  computes, so a loop that never ends is stopped at `timeoutMs` (a `try` /
  `catch` cannot catch that stop), and by a timer while it waits for a tool.
  Too many tool calls stop the script too, even if it catches the error.
- **The gate per call.** Each `tools.x(args)` is an inner tool call of the run:
  validated against the tool's schema, then pre-tool hooks, permission rules,
  the [permission mode](./permission-modes.md), [tool guardrails](./guardrails.md)
  and `needsApproval`, then the tool runs (through the run's sandbox when it is
  `requiresSandbox`) with the run's principal, then post-tool hooks. A denied call throws in the script with the denial's reason.
  A guardrail that blocks an inner call stops the whole run, as it does for a
  direct call.
- **Plan mode.** `run_code` is marked read-only: it changes nothing by itself.
  In plan mode each inner call is checked on its own, so a script can call
  read-only tools and a call to any other tool throws `denied by plan mode`.
- **Errors.** A tool's error reaches the script as its message only, never a
  host stack trace. Tokens a tool got from `ctx.getToken()` are redacted from
  its result, as for a direct call.

A script that computes without waiting runs on your process's thread: it
blocks the event loop until it ends or `timeoutMs` stops it. On a server that
handles other requests, keep `timeoutMs` low.

## Approvals, sign-ins and other pauses

A script cannot pause. A QuickJS isolate cannot be saved and resumed later, so
an inner call that would pause the run throws in the script instead, and the
run does not pause:

| The inner call | What the script gets |
| --- | --- |
| needs approval (`needsApproval`, an `ask` rule) | `Tool x needs approval; call it directly, not from run_code.` |
| needs a sign-in (`ctx.getToken()` without a token) | `Tool x needs the user to sign in to <provider>; call it directly, not from run_code.` |
| starts a sub-agent that needs approval | `Tool x started a sub-agent that needs approval; call it directly, not from run_code.` |

The model can then call that tool directly, which pauses the run as usual.
`run_code` itself can need approval (for example with `permissions: [ask('*')]`):
the run pauses before the script runs, and the script runs, with every inner
call checked, after the decision.

## Events and traces

Inner calls emit the usual `tool.start`, `tool.partial`, `tool.done` and
`tool.error` [events](./stream-events.md), with `parentToolCallId` set to the
`run_code` call's id. Their ids are `<run_code call id>:<n>`, numbered in the
order the script made the calls. Each inner call's `tool.done` or `tool.error`
comes before `run_code`'s own: when a script ends (or is stopped) while calls
it started are still running, their `abortSignal` is aborted and `run_code`
waits for them to settle. Inner calls also produce `permission.decision`
events, and hooks see them, under their own ids.

Inner results go to the events and to the script only. The transcript, the
session and the model get `run_code`'s result alone.

With tracing, each inner call has its own `execute_tool` span, a child of the
`run_code` span, with the attribute `lousho.tool.parent_call_id`.

## Limits and durability

- **No partial progress.** A script's state lives only in the isolate. After a
  crash, a resumed run calls `run_code` again and the whole script runs again,
  including the tool calls it had made. Make tools a script calls idempotent
  (each inner call's `ctx.toolCallId` is the same on a re-run: use it as an
  idempotency key), or call tools with side effects directly.
- **JavaScript only.** The model writes JavaScript; TypeScript is not
  transpiled.
- **Where it runs.** The runs of a `createAgent()` agent: `send()`, `stream()`,
  sessions, resumes and approvals, on Node. The `cloudflare-worker` target of
  `lousho build` does not bundle QuickJS: a run with `codeMode` fails there at
  its start. An agent started as a sub-agent (the `task`
  tool or a delegate tool) runs without code mode, and the lead's `codeMode`
  does not reach a sub-agent's tools.
- **Errors are results.** A script error, a timeout, the memory limit, too many
  tool calls or a return value over `maxOutputChars` is a tool error of
  `run_code` that names the cause; the model gets it and the run goes on.
