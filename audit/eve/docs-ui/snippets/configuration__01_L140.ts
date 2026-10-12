// configuration.md:140
import { agentSpecSchema, specToAgent, type McpServerSpec } from '@lousho/build-ai-agent';

const filesystem: McpServerSpec = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] };
const spec = agentSpecSchema.parse({
  name: 'support-bot',
  prompt: 'You are a friendly support agent.',
  provider: { type: 'mock', model: 'mock-1' },
  mcpServers: { filesystem, docs: { url: 'https://example.com/mcp' } },
});

// The servers connect on agent.ready() or the first send() / stream().
const agent = specToAgent(spec);
console.log(Object.keys(agent.mcpServers)); // ['filesystem', 'docs']
export {};
