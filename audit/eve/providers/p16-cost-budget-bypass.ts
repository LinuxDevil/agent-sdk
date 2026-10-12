// P16 (offline): limits.maxCostUsd vs an OpenRouter model the price table does not know.
// Each scripted call reports 2M prompt tokens (OpenRouter's usage.cost says $2.00 for claude-haiku-4.5).
// Run: npx tsx eve/providers/p16-cost-budget-bypass.ts
import { z } from 'zod';
import { createAgent, defineTool, OpenRouterProvider } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

function scripted() {
  let n = 0;
  const f: typeof fetch = async () => {
    n++;
    const toolTurn = n <= 3;
    const message = toolTurn
      ? { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }
      : { role: 'assistant', content: 'done' };
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message, finish_reason: toolTurn ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 10, total_tokens: 2_000_010, cost: 2.0 },
      }),
      { status: 200 },
    );
  };
  return { f, calls: () => n };
}

const lookup = defineTool({ name: 'lookup', description: 'look up', input: z.object({ q: z.string() }), execute: async () => 'ok' });
for (const model of ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5']) {
  const s = scripted();
  const agent = createAgent({
    provider: new OpenRouterProvider({ apiKey: 'k', defaultModel: model, fetch: s.f }),
    tools: [lookup],
    limits: { maxCostUsd: 0.01 },
    retry: false,
  });
  const r: any = await agent.send('go');
  console.log(JSON.stringify({ model, finishReason: r.finishReason, modelCalls: s.calls(), costUsd: r.usage.costUsd ?? null, providerReportedUsd: s.calls() * 2 }));
  if (model.startsWith('anthropic')) report('maxCostUsd 0.01 stops a $8 run', r.finishReason === 'budget-exceeded', `ran ${s.calls()} calls, finish=${r.finishReason}`);
}
