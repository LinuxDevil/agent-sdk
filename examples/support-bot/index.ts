/**
 * support-bot - a minimal customer-support agent built with createAgent().
 *
 * Defaults to a free, local mock provider so it runs with zero setup and
 * zero API cost. Set OPENAI_API_KEY to run it against real OpenAI instead.
 *
 * Run with: tsx examples/support-bot/index.ts
 */
import { createAgent } from 'lousho';
import { createMockProvider } from 'lousho';
import { resolveProvider } from 'lousho';

const provider = process.env.OPENAI_API_KEY
  ? resolveProvider('openai/gpt-4o-mini')
  : createMockProvider({
      responses: [
        "I'm sorry to hear that! Could you tell me your order number so I can look into it?",
      ],
    });

const agent = createAgent({
  name: 'support-bot',
  instructions:
    'You are a friendly customer support agent. Be concise, empathetic, and always ask for ' +
    'an order number when a customer reports a problem with an order.',
  provider,
});

async function main() {
  const result = await agent.send('Hi, my order arrived damaged.');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
