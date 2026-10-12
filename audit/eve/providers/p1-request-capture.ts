// P1: what actually goes on the wire. A fake fetch captures the request body
// the built-in OpenRouterProvider (via @ai-sdk/openai, ai 7) sends, for
// modelSettings (stop, seed, ...) and an `output` schema.
// Run: npx tsx eve/providers/p1-request-capture.ts
import { z } from 'zod';
import { createAgent, OpenRouterProvider, OpenAIProvider } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

const bodies: any[] = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  bodies.push(JSON.parse(String(init?.body)));
  return new Response(
    JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"city":"Paris","note":null,"tags":{}}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

// 1. modelSettings.stop (documented in ModelSettings / createAgent JSDoc)
{
  const agent = createAgent({
    provider: new OpenRouterProvider({ apiKey: 'k', defaultModel: 'openai/gpt-4o-mini', fetch: fakeFetch }),
    modelSettings: { stop: ['END'], seed: 7, temperature: 0.1 },
    retry: false,
  });
  await agent.send('hi');
  const b = bodies.at(-1);
  console.log('openrouter body keys:', Object.keys(b).join(','));
  report('modelSettings.stop reaches the wire (openrouter)', 'stop' in b, `stop=${JSON.stringify(b.stop)} seed=${b.seed} temperature=${b.temperature}`);
}
{
  const agent = createAgent({
    provider: new OpenAIProvider({ apiKey: 'k', defaultModel: 'gpt-4o-mini', api: 'chat', fetch: fakeFetch }),
    modelSettings: { stop: ['END'] },
    retry: false,
  });
  await agent.send('hi');
  const b = bodies.at(-1);
  report('modelSettings.stop reaches the wire (openai chat)', 'stop' in b, `stop=${JSON.stringify(b.stop)}`);
}

// 2. output schema -> response_format sent to the model
{
  const agent = createAgent({
    provider: new OpenRouterProvider({ apiKey: 'k', defaultModel: 'meta-llama/llama-3.3-70b-instruct', fetch: fakeFetch }),
    output: z.object({ city: z.string(), note: z.string().optional(), tags: z.record(z.string(), z.string()) }),
    retry: false,
  });
  const r = await agent.send('hi');
  const b = bodies.at(-1);
  console.log('response_format:', JSON.stringify(b.response_format));
  report('output: z.record survives strict', JSON.stringify(b.response_format).includes('"additionalProperties":{'), 'record -> additionalProperties:{type:string} under strict:true');
  console.log('object:', JSON.stringify(r.object), 'finish:', r.finishReason);
}
