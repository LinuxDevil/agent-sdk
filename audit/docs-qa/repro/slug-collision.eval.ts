/**
 * Repro: two cases whose labels differ only after char 45 (labels default to
 * the input) get the same cassette file, so --record silently overwrites the
 * first case's cassette and --replay of that case fails.
 */
import { createAgent, defineEval, includes } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

defineEval({
  name: 'slug collision',
  agent: () => createAgent({ provider: mockModel([(req) => `echo: ${req.messages.at(-1)?.content}`]) }),
  cases: [
    { input: 'How do I configure the retry policy and backoff for the OpenAI provider?' },
    { input: 'How do I configure the retry policy and backoff for the Anthropic provider?' },
  ],
  async test(t, c) {
    await t.send(c.input);
    t.check('echo', t.reply, includes(c.input));
  },
});
