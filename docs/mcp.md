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
`agent.close()` disconnects them (stops stdio processes); a later tool call
reconnects. Without `mcpServers`, `ready()` and `close()` do nothing.

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

stdio entries are spawned with `command` and `args`; `env` is added to the
default environment (`PATH` and the like), not a replacement for it. HTTP
entries use the streamable HTTP transport and send the static `headers` on every
request. An HTTP entry can also sign in with OAuth, as the MCP authorization
spec describes: add `oauth: { redirectUri }` and an operator signs the agent in
once; see [MCP servers with OAuth](./oauth.md#mcp-servers-with-oauth).

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

### Approval for MCP tools

MCP servers describe each tool with annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint` and a `title`). They are
hints, but the SDK uses them as the default for [approvals](./approvals.md):
a tool with `readOnlyHint: true` runs; a tool with `destructiveHint: true`, or
one that sends no `destructiveHint` (the MCP spec's default is destructive),
pauses the run until a human approves; `destructiveHint: false` runs. A tool
without annotations therefore asks. The raw annotations stay on
`descriptor.metadata.mcp.annotations`, and `title` becomes the `displayName`.

Set `approval` on a server entry (`mcpServers`, `createAgent`, `connectMcp()`) or
in `loadMcpTools(client, name, { approval })`:

- `'annotations'` (default): as above.
- `'always'` / `'never'`: ask for every tool / none of them.
- A function `({ name, annotations }) => boolean` decides per tool (`name` is
  the bare tool name; `annotations` is `{}` when the server sent none). Only
  in code; a spec file takes the three strings.

[Permission rules](./approvals.md#permission-policies) run first and can still
`allow`, `deny` or `ask`.

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  mcpServers: {
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
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
  without `auth` logs a warning.

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
