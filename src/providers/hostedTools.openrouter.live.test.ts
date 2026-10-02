/**
 * Live test (costs money, needs OPENROUTER_API_KEY): OpenRouter's web search
 * server tool through `webSearch()`, once with `agent.send()` and once with
 * `agent.stream()`. Run with `npm run test:live -- hostedTools.openrouter`.
 * Records `__fixtures__/cassettes/n1b-openrouter-web-search.json`, which
 * hostedTools.openrouter.replay.test.ts replays offline. About 0.007 USD per
 * search (Exa) plus tokens; N1b's cap is 0.10 USD.
 */

import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { webSearch } from '../tools/hosted';
import { OpenRouterProvider } from './OpenRouterProvider';

const PROMPT = 'Search the web: what is the latest version of Node.js? Answer in one line with the source URL.';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('OpenRouter web search (live)', () => {
  it('searches once with send() and once with stream()', async () => {
    const provider = recordReplay(new OpenRouterProvider({ name: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY! }), {
      cassette: 'src/providers/__fixtures__/cassettes/n1b-openrouter-web-search.json',
      mode: 'record',
    });
    const agent = createAgent({ provider, model: 'openai/gpt-4o-mini', tools: [webSearch({ maxUses: 1 })], maxSteps: 2 });

    const sent = await agent.send(PROMPT);
    expect(sent.usage.hostedToolCalls?.web_search).toBeGreaterThanOrEqual(1);

    let provided = 0;
    for await (const event of agent.stream(PROMPT)) {
      if (event.type === 'tool.start' && event.executedBy === 'provider') provided += 1;
    }
    expect(provided).toBeGreaterThanOrEqual(1);
  });
});
