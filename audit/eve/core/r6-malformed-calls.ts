// CORE: malformed tool calls / truncation / refusals from the model (deterministic).
// Run: npx tsx eve/core/r6-malformed-calls.ts
import { z } from 'zod';
import { createAgent, defineTool, type LLMProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const lookup = defineTool({
  name: 'lookup',
  description: 'Look something up',
  input: z.object({ q: z.string() }),
  execute: async ({ q }) => `data for ${q}`,
});

/** A provider replaying raw GenerateResults, recording what the model was sent. */
function raw(turns: any[]): LLMProvider & { seen: any[] } {
  const seen: any[] = [];
  let i = 0;
  return {
    name: 'raw',
    defaultModel: 'raw',
    seen,
    async generate(opts: any) {
      seen.push(structuredClone(opts.messages));
      return turns[Math.min(i++, turns.length - 1)];
    },
  } as any;
}

// A: truncated JSON args (finishReason 'length' mid tool call)
{
  const p = raw([
    { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q": "par' } }], finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const agent = createAgent({ provider: p, tools: [lookup] });
  const r = await agent.send('x');
  const toolMsg = p.seen[1]?.find((m: any) => m.role === 'tool');
  console.log('A truncated args -> finishReason=%s; tool result the model saw: %j', r.finishReason, String(toolMsg?.content).slice(0, 300));
}

// B: final answer truncated by maxTokens ('length'), with output schema
{
  const p = raw([
    { text: '{"city": "Par', finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { text: '{"city": "Par', finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  const agent = createAgent({ provider: p, output: z.object({ city: z.string() }), modelSettings: { maxTokens: 5 } });
  const r = await agent.send('x');
  console.log('B truncated output -> finishReason=%s outputError=%j', r.finishReason, r.outputError?.message?.slice(0, 200));
  const repairMsg = p.seen[1]?.at(-1);
  console.log('B repair prompt mentions truncation/length? %s :: %j', /trunc|length|max.?tokens|cut off/i.test(String(repairMsg?.content)), String(repairMsg?.content).slice(0, 200));
}

// C: plain text answer truncated, no output
{
  const p = raw([{ text: 'The answer is', finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }]);
  const r = await createAgent({ provider: p }).send('x');
  console.log('C truncated text -> finishReason=%s text=%j', r.finishReason, r.text);
}

// D: tool returns undefined / throws non-Error
{
  const boom = defineTool({ name: 'boom', description: 'b', input: z.object({}), execute: async () => { throw 'string thrown'; } });
  const m = mockModel([{ toolCalls: [{ name: 'boom' }] }, 'done']);
  const r = await createAgent({ provider: m, tools: [boom] }).send('x');
  const toolMsg = m.calls[1].messages.find((x: any) => x.role === 'tool');
  console.log('D non-Error throw -> model saw %j', String(toolMsg?.content).slice(0, 200));
}

// E: same tool call id twice in one turn (some local models do this)
{
  const p = raw([
    { text: '', toolCalls: [
      { id: 'dup', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
      { id: 'dup', type: 'function', function: { name: 'lookup', arguments: '{"q":"b"}' } },
    ], finishReason: 'tool_calls', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  try {
    const r = await createAgent({ provider: p, tools: [lookup] }).send('x');
    const tools = p.seen[1]?.filter((m: any) => m.role === 'tool');
    console.log('E duplicate ids -> finishReason=%s tool results=%j', r.finishReason, tools?.map((t: any) => [t.toolCallId, t.content]));
  } catch (e: any) {
    console.log('E duplicate ids -> threw %s', e.message);
  }
}

// F: empty-string tool call id
{
  const p = raw([
    { text: '', toolCalls: [{ id: '', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }], finishReason: 'tool_calls', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
  ]);
  try {
    const r = await createAgent({ provider: p, tools: [lookup] }).send('x');
    console.log('F empty id -> finishReason=%s', r.finishReason);
  } catch (e: any) {
    console.log('F empty id -> threw %s', e.message);
  }
}
