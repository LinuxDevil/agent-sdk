# Agent Client Protocol (ACP)

The [Agent Client Protocol](https://agentclientprotocol.com) lets an editor
drive a coding agent that runs as a subprocess: the editor writes JSON-RPC 2.0
requests to the agent's stdin, one JSON message per line, and reads the
agent's replies and streamed updates from its stdout. Zed and other editors
speak it. `lousho acp` serves any Lousho agent this way, so you can chat with
it, watch its tool calls and approve them from the editor's agent panel.

## The command

```bash
npx lousho acp agent.yaml                          # a spec file
npx lousho acp ./my-agent --model openai/gpt-4o    # an agent directory, on another model
npx lousho acp src/agent.ts                        # a .ts/.js module (createAgent() options or an agent)
```

```text
lousho acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]
```

`<path>` is loaded like [`lousho chat`](./cli.md#lousho-chat) loads it, and
`--model` works the same way. The editor starts the process; it runs until
stdin closes. stdout carries nothing but protocol messages: errors, and
anything the agent's code prints with `console.log`, go to stderr, which
editors show in their logs. A bad path or flag exits with code 1 and the coded
error (`LOUSHO_CONFIG_INVALID`, ...) on stderr.

## Zed

Add the agent to Zed's `settings.json`, then pick it in the agent panel:

```json
{
  "agent_servers": {
    "My Lousho agent": {
      "type": "custom",
      "command": "npx",
      "args": ["lousho", "acp", "/path/to/my-agent"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

Run it from the project that has `@lousho/build-ai-agent` installed (or use
an absolute path to `node_modules/.bin/lousho` as `command`). Provider keys
come from `env` or from the environment Zed was started in.

## What is supported

Protocol version 1. The agent answers:

| Method | What it does |
| ------ | ------------ |
| `initialize` | Returns `protocolVersion: 1`, `loadSession: false`, text-only prompt capabilities and no auth methods. |
| `session/new` | Opens an SDK session (`agent.session()`): the prompts of one ACP session share their history. Returns `{ sessionId }`. `cwd` and `mcpServers` are ignored; give the agent its MCP servers in its own config. |
| `session/prompt` | Runs one turn. Text blocks are the input; a `resource_link` block becomes a Markdown link to its URI. Resolves to `{ stopReason }` when the turn ends. |
| `session/cancel` (notification) | Aborts the session's running turn: its `session/prompt` resolves to `{ stopReason: 'cancelled' }`, and a permission request still open counts as rejected. |

While a turn runs the agent sends `session/update` notifications:

- `agent_message_chunk` with a `text` content block for each piece of text the model writes;
- `agent_thought_chunk` with a `text` content block for each piece of the model's [reasoning](./reasoning.md);
- `tool_call` (`status: 'in_progress'`, `kind: 'other'`, the tool's name as `title`, its arguments as `rawInput`) when a tool call starts;
- `tool_call_update` with `status: 'completed'` (the result as text content and as `rawOutput`) or `'failed'` (the error) when it ends.

Sub-agent runs started by the `task` tool are not forwarded; the `task` call
itself appears as one tool call.

**Permissions.** When a tool needs approval (`needsApproval`, `permissions`
rules that ask), the agent sends the editor a `session/request_permission`
request with the tool call and two options, `allow` (Allow, `allow_once`) and
`reject` (Reject, `reject_once`). The answer decides the approval with
`agent.approvals.streamResolve()` and the continued turn keeps streaming
updates; a rejection marks the tool call `failed` and the model carries on.
A turn may ask several times.

**Questions.** An `ask_question` pause (`askQuestion: true`) is not mapped to
a permission request, because the user's answer can be free text. It ends the
turn (`end_turn`) with the question, and its numbered options, as the agent's
message; the next prompt of the session is the answer
(`agent.approvals.streamAnswer()`).

**Stop reasons.** `end_turn` for a normal finish, `max_turn_requests` when
`maxSteps` ran out, `max_tokens` when a `limits` budget tripped or the model
stopped on its output limit, `refusal` when a guardrail blocked or the
provider's content filter stopped the model, and `cancelled` after
`session/cancel`.

**Errors.** An unknown method answers JSON-RPC error `-32601`, a line that is
not JSON `-32700`, an unknown `sessionId` or an empty prompt `-32602`, and a
second prompt while one runs in the same session `-32600`. A run that fails
answers `-32603` with the error's message, and its SDK error code (for
example `LOUSHO_PROVIDER_RATE_LIMITED`) in `error.data.code`.

## Not supported

- `session/load` (`loadSession: false`) and session modes.
- The client's `fs/*` and `terminal/*` methods: the agent reads files and runs
  commands with its own tools ([Workspace tools](./workspace-tools.md)), not
  through the editor.
- Image, audio and embedded-resource prompt blocks (text prompts only).
- `plan` updates, and `allow_always` /
  `reject_always` permission options.
- Authentication (`authMethods` is empty): provider keys come from the environment.

## In code

The protocol core is `serveAcp(agent, { input, write })`: it reads JSON-RPC
lines from any async iterable and hands each outgoing line to `write`, so you
can serve it over another transport or drive it in tests without a process.
It resolves once `input` ends, after aborting any running turn.

```ts
import * as readline from 'node:readline';
import { createAgent, serveAcp } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a coding assistant.' });

await serveAcp(agent, {
  input: readline.createInterface({ input: process.stdin }),
  write: (line) => process.stdout.write(`${line}\n`),
});
```

Pass `store` to keep the ACP sessions' transcripts in an `AgentStore` (for
example a `SqliteStore`); by default they use the agent's own `store`, or memory.
