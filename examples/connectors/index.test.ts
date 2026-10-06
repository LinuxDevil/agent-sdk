import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src';
import { mockModel } from '../../src/testing';
import { connectorSpecs } from './index';

// The test spawns the real mock-connectors stdio server - the honest check
// that MCP tool loading, namespacing and calls work end to end.
describe('examples/connectors', () => {
  it('the agent reads a doc and posts to a channel through MCP tools', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'connectors__docs_list_documents', args: {} }] },
      { toolCalls: [{ name: 'connectors__docs_get_document', args: { id: 'doc-1' } }] },
      { toolCalls: [{ name: 'connectors__slack_post_message', args: { channel: 'eng', text: 'hi' } }] },
      { text: 'Done.' },
    ]);
    const agent = createAgent({
      name: 't',
      instructions: 'use the tools',
      provider,
      mcpServers: connectorSpecs(),
    });

    const result = await agent.send('do the thing');
    expect(result.text).toBe('Done.');

    // The MCP results really came back through the transcript.
    const texts = JSON.stringify(result.messages ?? []);
    expect(texts).toContain('Launch plan');
    expect(texts).toContain('posted to eng');

    await agent.close(); // stops the stdio server
    provider.assertExhausted();
  }, 30_000);

  it('connectorSpecs() produces a stdio spec pointing at the mock server', () => {
    const spec = connectorSpecs().connectors;
    expect(spec).toMatchObject({ command: 'npx' });
    expect((spec as { args: string[] }).args.join(' ')).toContain('mock-connectors-server');
  });
});
