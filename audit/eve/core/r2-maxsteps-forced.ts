// CORE: maxSteps + forced-answer behavior (deterministic, mockModel).
// Run: npx tsx eve/core/r2-maxsteps-forced.ts
import { z } from 'zod';
import { createAgent, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const lookup = defineTool({
  name: 'lookup',
  description: 'Look something up',
  input: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ found: `data for ${q}` }),
});

// A: maxSteps without `output` - model still wants tools on the last step.
{
  const model = mockModel([{ text: 'Checking...', toolCalls: [{ name: 'lookup', args: { q: 'a' } }] }], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, tools: [lookup], maxSteps: 2 });
  const r = await agent.send('Find a');
  console.log('A (no output) finishReason=%s text=%j steps=%d lastMsgRole=%s', r.finishReason, r.text, r.steps, r.messages.at(-1)?.role);
}

// B: maxSteps WITH output - forced no-tools answer.
{
  const model = mockModel(
    [
      { toolCalls: [{ name: 'lookup', args: { q: 'a' } }] },
      { toolCalls: [{ name: 'lookup', args: { q: 'b' } }] },
      '{"answer":"done"}',
    ]
  );
  const agent = createAgent({ provider: model, tools: [lookup], maxSteps: 2, output: z.object({ answer: z.string() }) });
  const r = await agent.send('Find a and b');
  const last = model.lastCall!;
  console.log('B (output) finishReason=%s object=%j steps=%d modelCalls=%d', r.finishReason, r.object, r.steps, model.calls.length);
  console.log('B forced call: tools sent=%j toolChoice=%j; history has tool calls=%s', last.tools?.map((t) => t.function.name) ?? null, last.toolChoice ?? null, last.messages.some((m: any) => m.toolCalls?.length));
  const synthetic = r.messages.filter((m) => m.role === 'user' && String(m.content).includes('out of steps'));
  console.log('B synthetic "out of steps" USER messages in result.messages: %d -> %j', synthetic.length, synthetic.map((m) => m.content));
}

// C: same in a session - is the injected user message persisted into the transcript?
{
  const model = mockModel(
    [
      { toolCalls: [{ name: 'lookup', args: { q: 'a' } }] },
      '{"answer":"done"}',
      (req) => `turn2 sees ${req.messages.filter((m) => m.role === 'user').length} user messages`,
    ]
  );
  const store = memoryStore();
  const agent = createAgent({ provider: model, tools: [lookup], maxSteps: 1, store, output: z.object({ answer: z.string() }) });
  const session = agent.session({ id: 'sess-c' });
  const r1 = await session.send('Find a');
  const transcript = await session.load();
  console.log('C turn1 finishReason=%s object=%j', r1.finishReason, r1.object);
  console.log('C transcript user messages:', transcript.filter((m) => m.role === 'user').map((m) => m.content));
}

// D: maxSteps: 0 / -1 / 1.5 validation
for (const bad of [0, -1, 1.5, Number.NaN]) {
  try {
    const agent = createAgent({ provider: mockModel(['hi'], { onExhausted: 'repeat-last' }), maxSteps: bad });
    const r = await agent.send('x');
    console.log('D maxSteps=%s -> accepted at create; send finishReason=%s steps=%d text=%j', bad, r.finishReason, r.steps, r.text);
  } catch (e: any) {
    console.log('D maxSteps=%s -> threw %s %s', bad, e.code, e.message.slice(0, 120));
  }
}

// E: the output-repair prompt is also a synthetic USER message - persisted too?
{
  const model = mockModel(['not json', '{"answer":"ok"}']);
  const agent = createAgent({ provider: model, store: memoryStore(), output: z.object({ answer: z.string() }) });
  const s = agent.session({ id: 'sess-e' });
  await s.send('Answer please');
  console.log('E transcript user messages:', (await s.load()).filter((m) => m.role === 'user').map((m) => String(m.content).slice(0, 70)));
}
