/**
 * workflow-router - an agent whose job is to classify an incoming request
 * into one of a fixed set of routes/categories (LOU-H1's createAgent()).
 *
 * Defaults to a free, local mock provider so it runs with zero setup and
 * zero API cost. Set OPENAI_API_KEY to run it against real OpenAI instead.
 *
 * Run with: tsx examples/workflow-router/index.ts
 */
import { createAgent } from '../../src/createAgent';
import { createMockProvider } from '../../src/providers/mock';
import { resolveProvider } from '../../src/providers/resolveProvider';

const provider = process.env.OPENAI_API_KEY
  ? resolveProvider('openai/gpt-4o-mini')
  : createMockProvider({ responses: ['billing'] });

const agent = createAgent({
  name: 'workflow-router',
  prompt:
    'You are a request router. Given a customer message, reply with exactly one word: ' +
    "'billing', 'technical', or 'sales' - whichever category best matches the message.",
  provider,
});

async function main() {
  const result = await agent.send('I was charged twice for my subscription this month.');
  console.log(`Routed to: ${result.text}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
