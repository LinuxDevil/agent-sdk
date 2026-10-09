# connectors

Connect an agent to external services (Google Docs, Slack, GitHub, Notion, …) the way Claude's connectors do: **over MCP**.

```ts
const agent = createAgent({
  model: 'openrouter/openai/gpt-4o-mini',
  mcpServers: {
    slack: { url: 'https://mcp.slack.com/mcp', oauth: { redirectUri } },
  },
});
```

This example runs **fully offline** — `./mock-connectors-server.ts` is a real stdio MCP server (written with the SDK's own `serveMcp`) exposing fake `docs_*`/`slack_*` tools. The agent code is identical to what a real connector needs; only the `mcpServers` entry changes.

## Real connectors

| Service   | `mcpServers` entry |
| --------- | ------------------ |
| Google Docs/Drive | `{ url: '<google docs MCP endpoint>', oauth: { redirectUri: '<your callback>' } }` |
| Slack     | `{ url: 'https://mcp.slack.com/mcp', oauth: { redirectUri } }` |
| GitHub    | `{ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer <PAT>' } }` or the community stdio server via `command` |
| Notion    | `{ url: 'https://mcp.notion.com/mcp', oauth: { redirectUri } }` |
| Any local connector | `{ command: 'npx', args: ['-y', '<their-mcp-server>'] }` |

OAuth is **app-owned**: one operator signs the agent in once per server via `agent.oauth.mcpSignInUrl('slack')`; every run then reuses the grant. See [docs/oauth.md](../../docs/oauth.md) and [docs/connectors.md](../../docs/connectors.md).

## Write safety

`slack_post_message` carries `destructiveHint`/`readOnlyHint` annotations, and the demo sets `approval: 'never'` only so it runs non-interactively. In production keep the default (`'always'`), `'annotations'` for a server you trust, or an `approval` predicate/permission rules so connector *writes* pause for human approval — see [docs/approvals.md](../../docs/approvals.md).

```bash
npm run example:connectors            # offline, real MCP stdio round-trip
OPENROUTER_API_KEY=… npx tsx examples/connectors/index.ts
```
