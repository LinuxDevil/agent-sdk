/**
 * Eve audit repro: which GenerateOptions actually reach the wire?
 * Stub fetch captures the request body the provider sends.
 * Run: npx tsx audit/eve/repro-params.ts
 */
import { OpenAIProvider } from '../../src/providers/OpenAIProvider';

const bodies: unknown[] = [];
const stubFetch: typeof fetch = async (input, init) => {
  bodies.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

const provider = new OpenAIProvider({
  apiKey: 'dummy',
  api: 'chat',
  fetch: stubFetch,
  defaultModel: 'qwen3-8b',
});

await provider.generate({
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.3,
  maxTokens: 100,
  topP: 0.9,
  stop: ['END', 'DONE'],
  toolChoice: 'required',
  seed: 42,
  tools: [
    {
      type: 'function',
      function: {
        name: 'search',
        description: 'search',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
  ],
});

console.log('--- request body keys ---');
const body = bodies[0] as { body: Record<string, unknown> };
console.log(Object.keys(body.body));
console.log(JSON.stringify(body.body, null, 2).slice(0, 2000));
console.log('--- checks ---');
console.log('tool_choice sent:', 'tool_choice' in body.body);
console.log('stop sent:', 'stop' in body.body);
console.log('supportsTools(gpt-5):', provider.supportsTools('gpt-5'));
console.log('supportsTools(o3):', provider.supportsTools('o3'));
console.log('getModels:', await provider.getModels());
