/**
 * doc-qa - a question-answering agent scoped to a fixed document, built
 * with createAgent() (LOU-H1).
 *
 * Defaults to a free, local mock provider so it runs with zero setup and
 * zero API cost. Set OLLAMA_BASE_URL to run it against a local Ollama
 * instead.
 *
 * Run with: tsx examples/doc-qa/index.ts
 */
import { createAgent } from '../../src/createAgent';
import { createMockProvider } from '../../src/providers/mock';
import { resolveProvider } from '../../src/providers/resolveProvider';

const DOCUMENT = `
Lousho Refund Policy: Refunds are available within 30 days of purchase.
Digital goods are non-refundable once downloaded. Contact support with
your order number to request a refund.
`;

const provider = process.env.OLLAMA_BASE_URL
  ? resolveProvider('ollama/llama3')
  : createMockProvider({
      responses: ['According to the policy, refunds are available within 30 days of purchase.'],
    });

const agent = createAgent({
  name: 'doc-qa',
  prompt:
    `You answer questions using ONLY the following document. If the answer isn't in the ` +
    `document, say so.\n\nDocument:\n${DOCUMENT}`,
  provider,
});

async function main() {
  const result = await agent.send('How long do I have to request a refund?');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
