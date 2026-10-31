/**
 * research-assistant - an agent with the built-in `http` tool wired up, so
 * it can fetch pages/APIs while researching a question (using
 * createAgent()).
 *
 * Defaults to a free, local mock provider so it runs with zero setup and
 * zero API cost. Set ANTHROPIC_API_KEY to run it against real Anthropic
 * instead.
 *
 * Run with: tsx examples/research-assistant/index.ts
 */
import { createAgent } from 'lousho';
import { createMockProvider } from 'lousho';
import { resolveProvider } from 'lousho';
import { httpTool } from 'lousho';

const provider = process.env.ANTHROPIC_API_KEY
  ? resolveProvider('anthropic/claude-3-5-sonnet-latest')
  : createMockProvider({
      responses: ['Based on my research, here is a concise summary of the topic.'],
    });

const agent = createAgent({
  name: 'research-assistant',
  instructions:
    'You are a diligent research assistant. Use the http tool to fetch sources when needed, ' +
    'and always summarize findings concisely with citations.',
  provider,
  tools: { http: httpTool },
});

async function main() {
  const result = await agent.send('Summarize the latest news about renewable energy.');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
