/**
 * Fixture for src/cli/eval.test.ts: two cases whose inputs only differ after
 * 45 characters (their display labels are equal), so each must still get its
 * own cassette. Its cassettes are written to __cassettes__/ and deleted by the test.
 */
import { createAgent } from '../../../createAgent';
import { defineEval, includes } from '../../../evals';
import { mockModel } from '../../../testing';

defineEval({
  name: 'slug collision',
  agent: () =>
    createAgent({
      prompt: 'p',
      provider: process.env.FIXTURE_PROVIDER === 'offline' ? mockModel([]) : mockModel([(req) => `echo: ${String(req.messages.at(-1)?.content)}`]),
    }),
  cases: [
    { input: 'How do I configure the retry policy and backoff for the OpenAI provider?' },
    { input: 'How do I configure the retry policy and backoff for the Anthropic provider?' },
  ],
  async test(t, c) {
    await t.send(c.input);
    t.check('echo', t.reply, includes(c.input));
  },
});
