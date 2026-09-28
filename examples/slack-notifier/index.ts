/**
 * slack-notifier - an agent that drafts a Slack-ready notification message
 * from a raw event description, built with createAgent() (LOU-H1).
 *
 * Defaults to a free, local mock provider so it runs with zero setup and
 * zero API cost. Set OPENAI_API_KEY to run it against real OpenAI instead.
 *
 * Run with: tsx examples/slack-notifier/index.ts
 */
import { createAgent } from '../../src/createAgent';
import { createMockProvider } from '../../src/providers/mock';
import { resolveProvider } from '../../src/providers/resolveProvider';

const provider = process.env.OPENAI_API_KEY
  ? resolveProvider('openai/gpt-4o-mini')
  : createMockProvider({
      responses: [':rotating_light: Deploy to production failed - build #482. cc @on-call'],
    });

const agent = createAgent({
  name: 'slack-notifier',
  prompt:
    'You turn a raw event description into a short, Slack-ready notification message, using ' +
    'Slack emoji shorthand (e.g. :rotating_light:) where it fits.',
  provider,
});

async function main() {
  const result = await agent.send('Deploy to production failed on build #482.');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
