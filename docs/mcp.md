# MCP (Model Context Protocol)

MCP works in two directions. Your agent can call the tools of MCP servers, or
your agent can be an MCP server that Claude Code, Cursor and other MCP clients
call. Both live in the `@lousho/build-ai-agent/mcp` subpath, and
`@modelcontextprotocol/sdk` is an optional peer: install it to use either
direction.

```sh
npm install @modelcontextprotocol/sdk
```

`connectMcp`, `loadMcpTools` and `serveMcp` are exported from
`@lousho/build-ai-agent/mcp`; the package root and `@lousho/build-ai-agent/tools`
export them too. `createAgent({ mcpServers })` needs no import from the subpath.

## Use MCP servers in an agent

`createAgent({ mcpServers })` takes the same map. The servers connect on
`await agent.ready()` or, automatically, on the first `send()` / `stream()`;
each server's tools are added as `<server>__<tool>` (e.g. `docs__search`).
A server that cannot connect fails that call, and the next call tries again.
`agent.close()` disconnects them (stops stdio processes); a later tool call,
or `ready()`, reconnects. Without `mcpServers`, `ready()` and `close()` do nothing. The
`vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  mcpServers: {
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer <token>' } },
  },
});
const { text } = await agent.send('List the files here.');
await agent.close();
```

stdio entries are spawned with `command` and `args` (in `cwd`, when set); `env`
is added to the default environment (`PATH` and the like), not a replacement for
it. A server that does not start fails with
[`LOUSHO_MCP_START_FAILED`](./errors.md#lousho_mcp_start_failed), whose message
has the exit code and the last lines the process wrote to stderr.
`stderr: 'forward'` (default) also copies the process's stderr to this one's,
`'capture'` only keeps the last lines, and `'inherit'` / `'ignore'` keep none.
`connectTimeoutMs` (stdio or HTTP) bounds the `initialize` handshake; the
default is the MCP SDK's 60 seconds. HTTP
entries use the streamable HTTP transport and send the static `headers` on every
request. An HTTP entry can also sign in with OAuth, as the MCP authorization
spec describes: add `oauth: { redirectUri }` and an operator signs the agent in
once; see [MCP servers with OAuth](./oauth.md#mcp-servers-with-oauth).

Each tool call gets the run's abort signal, so aborting a run cancels the MCP
call in flight. `timeoutMs` on an entry (stdio or HTTP) bounds each call to
that server; without it the MCP SDK's default of 60 seconds applies.
`loadMcpTools(client, name, { timeoutMs })` takes the same option.

A tool result whose content is only text reaches the model as `{ "text": ... }`.
The result object still has `content` (the parts) for code that reads it, but
it is not sent to the model a second time. Results with images, audio or
resources keep every part, and `structuredContent` is used as the result when
the server sends it.

The map is the same one a spec file declares; see
[Configuration](./configuration.md) (the `mcpServers` section) for the YAML form.

### Share servers with `connectMcp()`

To share servers between agents, or to choose how failures are handled, call
`connectMcp(servers, options?)` and pass its `tools` yourself. It connects every
server and lists its tools before it resolves, so tools are known up front.
Options:

- `onError`: `'throw'` (default) rejects when a server cannot connect, after
  closing the others; `'skip'` leaves that server out and warns through `logger`.
- `lazy` (default `true`): after `close()` or a dropped connection, the next
  tool call reconnects. With `false` that call fails instead. Listing tools
  needs a connection, so `lazy` never delays the first connect.
- `logger`: receives skipped-server and skipped-tool warnings (default: none).
- `tokens`: the token store (`AgentStore.tokens`) of servers with `oauth`;
  required when any server has `oauth`.

It returns `{ tools, close(), status() }`; `status()` maps each server to
`'idle'`, `'connected'`, `'failed'` or `'needs-auth'` (an `oauth` server the
app is not signed in to).

`tools` is a `Record<string, ToolDescriptor>` keyed `<server>__<tool>` — a
map, not the array `defineTool()` results make. `createAgent({ tools })` takes
both forms, and they combine: `tools: [myTool, mcp.tools]` registers the array
entries under their own names and the record's entries under their keys, so
own tools and MCP tools can sit in one list. (Spreading into one record,
`tools: { ...mcp.tools, my_tool: myTool }`, works too.)

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';
import { connectMcp } from '@lousho/build-ai-agent/mcp';

const mcp = await connectMcp(
  { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
  { onError: 'skip', logger: console }
);
console.log(mcp.status()); // { files: 'connected' }
const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: mcp.tools });
await agent.send('List the files here.');
await mcp.close();
```

`mcp.tools` is a record, and `tools` also takes an array, so the two shapes
mix: `tools: [mcp.tools, weatherTool]` or `tools: [...createFsTools(workspace),
...Object.values(mcp.tools)]` (each MCP descriptor carries its
`<server>__<tool>` name, so `Object.values` works too).

### Tool names and filtering

Providers accept tool names matching `^[a-zA-Z0-9_-]{1,64}$`; MCP allows more.
A `<server>__<tool>` name with other characters has them replaced by `_`, and a
name over 64 characters is shortened, with a short hash so names stay distinct;
names that still collide get a `_2`, `_3` suffix. The server is always called
with the tool's own name, which `descriptor.metadata.mcp.tool` keeps, and a
renamed tool is logged as a warning. Valid names are unchanged.

An MCP tool may not take the name of another tool of the agent: if a server's
`<server>__<tool>` equals a local tool's name, the run fails with
`LOUSHO_CONFIG_INVALID` instead of the MCP tool replacing the local one (and its
approval gate). Rename the local tool, or leave the MCP tool out with
`tools: { exclude }`.

`tools: { include, exclude }` on a server entry (or
`loadMcpTools(client, name, { tools })`) loads only some of its tools, by their
MCP names: `include` keeps only those listed, then `exclude` drops those listed.
An `include` name the server does not offer is logged as a warning.

```ts no-run
const mcpServers = {
  hosting: { command: 'npx', args: ['-y', 'hosting-mcp'], tools: { exclude: ['multi-execute'] } },
};
```

### Approval for MCP tools

By default **every MCP tool asks for [approval](./approvals.md)**: the run
pauses until a human (or your `approve` callback) decides.

MCP servers describe each tool with annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint` and a `title`). They are
the server's own word, not a guarantee, so the SDK trusts them only when you opt
in with `approval: 'annotations'`: a tool with `readOnlyHint: true` then runs
(and may run in [plan mode](./permission-modes.md)); a tool with
`destructiveHint: true`, or one that sends no `destructiveHint` (the MCP spec's
default is destructive), pauses the run until a human approves;
`destructiveHint: false` runs. The raw annotations stay on
`descriptor.metadata.mcp.annotations` either way, and `title` becomes the
`displayName`.

Set `approval` on a server entry (`mcpServers`, `createAgent`, `connectMcp()`) or
in `loadMcpTools(client, name, { approval })`:

- `'always'` (default): ask for every tool. Plan mode refuses every tool of the
  server.
- `'annotations'`: trust the server's hints, as above. Use it only for servers
  you trust.
- `'never'`: ask for none of them.
- A function `({ name, annotations, args }) => boolean` decides per call
  (`name` is the bare tool name; `annotations` is `{}` when the server sent
  none; `args` are the call's arguments). It lets you gate a meta-tool such as
  `execute({ operation })` by its arguments, since server hints are not always
  right. Only in code; a spec file takes the three strings.

[Permission rules](./approvals.md#permission-policies) run first and can still
`allow`, `deny` or `ask`.

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  mcpServers: {
    // The default: every tool asks.
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    // A server you trust to label its tools: its read-only tools run.
    github: { url: 'https://api.githubcopilot.com/mcp/', approval: 'annotations' },
    // Ask before anything except tools whose name starts with `search`.
    docs: { url: 'https://example.com/mcp', approval: ({ name }) => !name.startsWith('search') },
    // A server you trust: never ask.
    scratch: { command: 'node', args: ['./scratch-server.js'], approval: 'never' },
  },
});
```

### Tools from a client you connected yourself

Connect a `Client` from `@modelcontextprotocol/sdk` yourself and load
its tools with `loadMcpTools()`, then pass the result to `createAgent()` (or
register it on a `ToolRegistry`):

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
const agent = createAgent({ prompt: '...', provider, tools });
```

`loadMcpTools` is also available from the package root and from
`@lousho/build-ai-agent/tools`.

## Serve an agent over MCP

`serveMcp()` is the reverse of `loadMcpTools()`: it exposes an agent (and,
optionally, some of its tools) as an MCP server, so Claude Code, Cursor and
other MCP clients can call it.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { serveMcp } from '@lousho/build-ai-agent/mcp';
import { z } from 'zod';

const searchDocs = defineTool({
  name: 'search_docs',
  description: 'Search the docs',
  input: z.object({ query: z.string() }),
  execute: ({ query }) => `results for ${query}`,
});

const supportAgent = createAgent({ prompt: 'You answer support questions.', provider, tools: [searchDocs] });

const server = await serveMcp({
  agent: supportAgent,            // exposed as ONE tool taking { message: string }
  name: 'support-bot',            // server name; the tool name defaults to a sanitized version
  description: 'Ask the support agent a question',
  tools: [searchDocs],            // optional: also expose these tools directly
  transport: { type: 'http', port: 3920, host: '127.0.0.1', path: '/mcp' }, // default: 'stdio'
});
await server.close();
```

- **Stateless.** Every call to the agent tool is a fresh conversation.
- **Cancellation.** Cancelling the MCP request aborts the agent run
  (`agent.send(message, { signal })`).
- **Errors.** An agent failure comes back as an MCP result with `isError: true`.
- **Approvals.** Approval-gated tools cannot be approved over MCP. A run that
  pauses for approval returns `isError: true` with a message saying so. Tools
  flagged `needsApproval` are not exposed directly unless you pass
  `allowApprovalTools: true`; if you do, clients run them with **no human gate**.
- **stdio.** Nothing but the MCP protocol is written to stdout; warnings go to stderr.
- **HTTP.** Binds `127.0.0.1` by default. Add `auth: { type: 'bearer', token }`
  to require an `Authorization: Bearer` header; binding a non-loopback host
  without `auth` logs a warning. To block DNS rebinding (a web page re-pointing
  its own domain at your machine), a loopback bind answers `403` unless the
  `Host` header is `localhost`, `127.x.x.x` or `[::1]`, and any request whose
  `Origin` header is not same-origin with `Host` gets `403`. Set
  `allowedHosts: ['mcp.internal']` to accept other names (it replaces the
  loopback default; on a non-loopback bind there is no Host check unless you
  set it) and `allowedOrigins: ['https://app.example']` to accept browser
  requests from another origin. `['*']` turns either check off.

### Annotations

`tools/list` carries MCP annotations so clients can tell what a tool does. A tool
that needs approval is advertised `readOnlyHint: false, destructiveHint: true`;
state hints yourself with `annotations` (sent verbatim). A tool with no hints sends
none, so a Lousho agent consuming this server keeps asking before it runs (see
`approval` on `connectMcp()`); `readOnlyHint: true` runs without asking. A tool that
needs approval is never advertised read-only. The built-in `read_file`, `list_dir`,
`glob`, `grep`, `todo_read`, `current_date` and `day_name` tools are read-only.

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  annotations: { readOnlyHint: true, destructiveHint: false, title: 'Look up order' },
  execute: ({ id }) => ({ id, status: 'shipped' }),
});
```

### From the command line

`lousho mcp` serves an agent spec file (stdio by default):

```sh
npx lousho mcp agent.yaml
npx lousho mcp agent.yaml --http --port 3920 --host 127.0.0.1
```

To use it from an MCP client, add it to the client's MCP config (for example
`.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "support-bot": { "command": "npx", "args": ["lousho", "mcp", "agent.yaml"] }
  }
}
```

## Limits

- Approval-gated tools cannot be approved over MCP when you serve an agent: a run that pauses for approval returns `isError: true`, and tools flagged `needsApproval` are not exposed unless `allowApprovalTools` is set.
- HTTP clients send static `headers` on every request. OAuth (`oauth`) is app-owned: one grant per server for the whole agent, signed in by an operator; there are no per-user MCP grants yet.
- `serveMcp()` calls are stateless: each call to the agent tool is a fresh conversation, and the HTTP transport accepts `POST` only.
