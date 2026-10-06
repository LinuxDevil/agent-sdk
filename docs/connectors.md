# Connectors

Connectors are how the agent reaches external services — Google Docs, Slack,
GitHub, Notion, a database — the way Claude's connectors do. In Lousho a
connector is an **MCP server**: add it to `mcpServers` and its tools join the
agent's registry namespaced as `<server>__<tool>`.

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openrouter/openai/gpt-4o-mini',
  mcpServers: {
    slack: { url: 'https://mcp.slack.com/mcp', oauth: { redirectUri: 'https://app.example.com/oauth/callback' } },
    github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } },
  },
});
```

## Two shapes

- **Remote (HTTP)** — `{ url, headers?, oauth? }`. This is what Google Docs,
  Slack, Notion and most Claude-style connectors are: a hosted MCP endpoint.
- **Local (stdio)** — `{ command, args?, env? }`. Community and in-house
  connectors shipped as npm packages: `{ command: 'npx', args: ['-y', 'their-mcp-server'] }`.

The full option reference is in [MCP](./mcp.md); OAuth sign-in flow in
[OAuth](./oauth.md#mcp-servers-with-oauth).

## Auth

- **OAuth connectors** (Slack, Google Docs, Notion): set `oauth` on the server
  entry. One *operator* signs the agent in once via
  `agent.oauth.mcpSignInUrl('slack')`; the grant belongs to the app and every
  run reuses it. A token `store` on `createAgent` keeps grants durable.
- **Token connectors** (GitHub PAT, internal APIs): pass a static
  `Authorization` header; keep the token in env, never in source.
- **stdio connectors**: secrets go in `env`, e.g.
  `{ command: 'npx', args: [...], env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! } }`.

## Approval for connector writes

Reads should run free; writes should ask. MCP tools carry
`readOnlyHint`/`destructiveHint` annotations, and the default
`approval: 'annotations'` turns those into the SDK's approval gate: a
`slack.post_message` pauses the run until approved, `docs.get_document` does
not. Tune it per server:

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = mockModel([{ text: 'ok' }]);

const agent = createAgent({
  provider,
  mcpServers: {
    slack: {
      url: 'https://mcp.slack.com/mcp',
      // Ask before any write, never before reads whose server marked them read-only.
      approval: 'annotations', // default; or ({ name }) => !name.startsWith('search')
    },
    scratch: { command: 'node', args: ['./local.js'], approval: 'never' },
  },
});
```

[Permission rules](./approvals.md#permission-policies) can gate connector tools
too — `mcp.slack.*` matchers apply to the namespaced tool names.

## Try it offline

[examples/connectors](../examples/connectors/) runs the whole pattern against
a mock stdio MCP server (written with `serveMcp`) — fake `docs_*`/`slack_*`
tools, no credentials, real MCP round-trip. Swap the `mcpServers` entry for a
real endpoint and nothing else changes.

## Serving your own connector

`serveMcp()` (see [MCP](./mcp.md#serve-an-agent-over-mcp)) exposes an agent
or a set of `defineTool()` tools as a stdio/HTTP MCP server — that is how a
Lousho agent *becomes* a connector for Claude Code or another harness.
