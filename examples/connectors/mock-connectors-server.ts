/**
 * mock-connectors-server - a stdio MCP server that stands in for real
 * connectors (Google Docs, Slack) so the example runs offline and in CI.
 *
 * It exposes connector-shaped tools - docs.get_document, docs.list_documents,
 * slack.list_channels, slack.post_message - over the MCP protocol, the same
 * surface a real remote MCP connector would. The agent in index.ts connects
 * with the same `mcpServers` config it would use for the real service; only
 * the `command`/`url` line differs.
 *
 * Written with the SDK's own serveMcp(): one dummy agent satisfies the
 * required `agent` option; the connector tools ride in `tools`.
 */
import { z } from 'zod';
import { createAgent, defineTool } from '../../src';
import { serveMcp } from '../../src/tools/mcp';
import { mockModel } from '../../src/testing';

const DOCS = new Map<string, string>([
  ['doc-1', '# Launch plan\n\nShip the connector example on Friday.'],
  ['doc-2', '# Incident review\n\nRoot cause: a stale cache header.'],
]);

const CHANNELS = new Map<string, string[]>([
  ['general', []],
  ['eng', []],
]);

const docsTools = [
  defineTool({
    name: 'docs_list_documents',
    description: 'List document ids in the connected drive.',
    input: z.object({}),
    annotations: { readOnlyHint: true },
    execute: async () => [...DOCS.keys()],
  }),
  defineTool({
    name: 'docs_get_document',
    description: 'Fetch a document by id.',
    input: z.object({ id: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ id }) => DOCS.get(id) ?? `no document ${id}`,
  }),
];

const slackTools = [
  defineTool({
    name: 'slack_list_channels',
    description: 'List channels in the connected workspace.',
    input: z.object({}),
    annotations: { readOnlyHint: true },
    execute: async () => [...CHANNELS.keys()],
  }),
  defineTool({
    name: 'slack_post_message',
    description: 'Post a message to a channel. WRITE action - a real connector would need approval.',
    input: z.object({ channel: z.string(), text: z.string() }),
    // The write annotation: a client on the default 'annotations' approval
    // pauses for approval before this runs, exactly like a real connector.
    annotations: { readOnlyHint: false, destructiveHint: true },
    execute: async ({ channel, text }) => {
      if (!CHANNELS.has(channel)) return `no channel ${channel}`;
      CHANNELS.get(channel)!.push(text);
      return `posted to ${channel}`;
    },
  }),
];

async function main() {
  // serveMcp requires an agent (exposed as one `send`-style tool); the mock
  // model answers it minimally - the connector tools are what matter here.
  const dummy = createAgent({ name: 'connectors', provider: mockModel([{ text: 'ok' }], { onExhausted: 'repeat-last' }) });
  await serveMcp({
    agent: dummy,
    name: 'mock-connectors',
    description: 'Mock Google Docs + Slack connector (offline stand-in)',
    tools: [...docsTools, ...slackTools],
    // slack_post_message is a write; flag it so the client's approval
    // machinery treats it like a real connector write would.
    warn: (m) => process.stderr.write(`[mock-connectors] ${m}\n`),
  });
}

main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exit(1);
});
