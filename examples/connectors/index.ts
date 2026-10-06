/**
 * connectors - connecting an agent to external services (Google Docs, Slack,
 * GitHub, Notion, ...) the way Claude's connectors do: over MCP.
 *
 * The Lousho shape is `mcpServers` on createAgent(): each entry is a
 * stdio (`command`/`args`) or HTTP (`url`) MCP server whose tools join the
 * agent's tool registry namespaced by the server name. Real services are
 * remote MCP servers reached over HTTP, usually behind OAuth
 * (`mcpServers.*.oauth`, see docs/oauth.md).
 *
 * This example runs OFFLINE against a mock connector server
 * (./mock-connectors-server.ts, a stdio MCP server serving fake
 * docs.get_document / slack.post_message tools) so it works with no
 * credentials. Point `mcpServers` at a real remote MCP server - the
 * README maps Google Docs, Slack, GitHub and Notion - and the agent code
 * below is unchanged.
 *
 * The Slack write goes through the SDK's MCP approval gate: the tool's
 * destructive annotation + an `approval` predicate make the run pause for
 * approval before the write executes.
 *
 * Run with: npx tsx examples/connectors/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgent, resolveProvider, type LLMProvider } from '../../src';
import { mockModel } from '../../src/testing';
import { type McpServerSpec } from '../../src/spec/schema';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

/** The one line that swaps mock for real: a stdio command or an HTTP url+oauth. */
export function connectorSpecs(): Record<string, McpServerSpec> {
  return {
    // Offline: the mock server in this directory. `approval: 'never'` keeps
    // the demo non-interactive; drop it (or pass a predicate) so writes like
    // slack_post_message pause for approval, as a real connector should.
    connectors: {
      command: 'npx',
      args: ['tsx', new URL('./mock-connectors-server.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
      approval: 'never',
    },
    // Real examples (see README):
    //   'google-docs': { url: 'https://gdocs.mcp.claude.com/mcp', oauth: { redirectUri: 'https://app.example.com/oauth/callback' } },
    //   slack:         { url: 'https://mcp.slack.com/mcp',        oauth: { redirectUri: 'https://app.example.com/oauth/callback' } },
  };
}

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const provider = mockModel([
    // Turn 1: list docs, then read doc-1, then post to #eng.
    { toolCalls: [{ name: 'connectors__docs_list_documents', args: {} }] },
    { toolCalls: [{ name: 'connectors__docs_get_document', args: { id: 'doc-1' } }] },
    { toolCalls: [{ name: 'connectors__slack_post_message', args: { channel: 'eng', text: 'Launch plan is in doc-1' } }] },
    { text: 'Posted the launch plan summary to #eng.' },
  ]);

  const agent = createAgent({
    name: 'connector-agent',
    instructions: 'You help with documents and chat. Use the connector tools.',
    ...(live ? { model: LIVE_MODEL } : { provider }),
    mcpServers: connectorSpecs(),
  });

  console.log(live ? `Live on ${LIVE_MODEL}` : 'Offline (mock MCP connector)');
  const result = await agent.send(
    'List the documents, read the launch plan, and post a one-line summary to the eng channel.'
  );
  console.log(result.text);
  await agent.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
