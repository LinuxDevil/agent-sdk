// P13 (offline): how non-standard / failure finish reasons surface through createAgent.
// OpenRouter documents finish_reason "error" on a 200 when the upstream fails mid-generation.
// Run: npx tsx eve/providers/p13-finish-reasons.ts
import { z } from 'zod';
import { createAgent, OpenRouterProvider } from '@lousho/build-ai-agent';

function fake(finish: string, content: string) {
  let calls = 0;
  const f: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
      { status: 200 },
    );
  };
  return { f, calls: () => calls };
}

for (const [finish, content] of [['error', 'The capital of Fr'], ['length', '{"city":"Par'], ['content_filter', '']] as const) {
  const s = fake(finish, content);
  const agent = createAgent({ provider: new OpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: s.f }), retry: { maxRetries: 2 } });
  try {
    const r: any = await agent.send('hi');
    console.log(JSON.stringify({ upstream: finish, threw: false, finishReason: r.finishReason, text: r.text, calls: s.calls() }));
  } catch (e: any) {
    console.log(JSON.stringify({ upstream: finish, threw: true, code: e.code, calls: s.calls() }));
  }
}

// truncated JSON with an output schema: does the repair step notice truncation (and raise maxTokens)?
{
  const s = fake('length', '{"city":"Par');
  const agent = createAgent({ provider: new OpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: s.f }), output: z.object({ city: z.string() }), modelSettings: { maxTokens: 5 } });
  const r: any = await agent.send('hi');
  console.log(JSON.stringify({ case: 'output + length', finishReason: r.finishReason, outputError: r.outputError?.message, calls: s.calls() }));
}
