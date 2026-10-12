// Runtime checks for docs/structured-output.md claims.
import { z } from 'zod';
import { createAgent, defineTool, createMockProvider } from '@lousho/build-ai-agent';
import { AgentBuilder, AgentExecutor } from '@lousho/build-ai-agent/executor';
import { mockModel } from '@lousho/build-ai-agent/testing';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));
const W = z.object({ city: z.string(), tempC: z.number() });

// repair flow + message wording
{
  const model = mockModel(['{"city":"Paris","tempC":"21"}', '{"city":"Paris","tempC":21}']);
  const r = await createAgent({ provider: model, output: W }).send('w');
  log('repair result', { fr: r.finishReason, obj: r.object, repaired: (r as any).outputRepaired });
  const repairMsg = model.calls[1].messages.at(-1) as any;
  log('repair msg', String(repairMsg.content).slice(0, 300));
  log('responseFormat', model.calls[0].responseFormat ? Object.keys(model.calls[0].responseFormat as any) : 'MISSING');
  const sys = String(model.calls[0].messages[0].content);
  log('sys has Output format', sys.includes('## Output format'));
}

// still invalid -> output-invalid, resolves, outputError shape
{
  const model = mockModel(['{"city":"Paris","tempC":"x"}', '{"city":"Paris","tempC":"y"}']);
  const r = await createAgent({ provider: model, output: W }).send('w');
  log('invalid result', { fr: r.finishReason, obj: r.object, err: r.outputError });
}

// near-miss: prose prefix, think block, trailing prose after fence
for (const reply of [
  'Sure! Here you go: {"city":"Paris","tempC":21}',
  '<think>{"bad":1}</think>{"city":"Paris","tempC":21}',
  '```json\n{"city":"Paris","tempC":21}\n```\nHope that helps!',
]) {
  const model = mockModel([reply], { onExhausted: 'repeat-last' });
  const r = await createAgent({ provider: model, output: W }).send('w');
  log('near-miss', { reply: reply.slice(0, 25), fr: r.finishReason, obj: r.object, calls: model.calls.length, textKept: r.text === reply });
}

// optional -> null removed; nullable keeps null
{
  const S = z.object({ verdict: z.string(), note: z.string().optional(), n2: z.string().nullable(), d: z.string().default('dflt') });
  const model = mockModel(['{"verdict":"approve","note":null,"n2":null,"d":null}']);
  const r = await createAgent({ provider: model, output: S }).send('x');
  log('optional null', { fr: r.finishReason, obj: r.object, issues: r.outputError?.issues });
  const schema = (model.calls[0].responseFormat as any)?.schema;
  log('sent schema', JSON.stringify(schema).slice(0, 400));
}

// root union non-object & z.date
{
  try { createAgent({ provider: mockModel(['x']), output: z.union([z.object({ a: z.string() }), z.string()]) as any }); log('root union non-object', 'no throw'); } catch (e: any) { log('root union non-object', `${e.name} ${e.code}: ${e.message.slice(0, 120)}`); }
  try { createAgent({ provider: mockModel(['x']), output: z.object({ when: z.date() }) }); log('z.date', 'no throw'); } catch (e: any) { log('z.date', `${e.name} ${e.code}: ${e.message.slice(0, 160)}`); }
  try { createAgent({ provider: mockModel(['x']), output: z.object({ when: z.object({ inner: z.array(z.date()) }) }) }); log('nested z.date', 'no throw'); } catch (e: any) { log('nested z.date', `${e.name}: ${e.message.slice(0, 120)}`); }
  try { createAgent({ provider: mockModel(['x']), output: z.array(z.object({ a: z.string() })) as any }); log('root array', 'no throw'); } catch (e: any) { log('root array', `${e.name}: ${e.message.slice(0, 120)}`); }
  // root discriminated union of objects
  const DU = z.discriminatedUnion('k', [z.object({ k: z.literal('a'), x: z.number() }), z.object({ k: z.literal('b'), y: z.string() })]);
  const m = mockModel(['{"k":"b","y":"hi"}']);
  const r = await createAgent({ provider: m, output: DU }).send('x');
  log('root DU', { fr: r.finishReason, obj: r.object, schemaType: (m.calls[0].responseFormat as any)?.schema?.type });
}

// max steps forced answer
{
  const t = defineTool({ name: 'again', description: 'x', input: z.object({}), execute: async () => 'ok' });
  const model = mockModel([{ toolCalls: [{ name: 'again' }] }, { toolCalls: [{ name: 'again' }] }, '{"city":"Paris","tempC":21}']);
  const r = await createAgent({ provider: model, output: W, tools: [t], maxSteps: 2 }).send('x');
  log('max-steps forced', { fr: r.finishReason, obj: r.object, calls: model.calls.length, lastHasTools: !!model.calls.at(-1)?.tools?.length });
}

// repair step counts against maxSteps; none when budget spent
{
  const model = mockModel(['{"city":"Paris","tempC":"21"}', '{"city":"Paris","tempC":21}']);
  const r = await createAgent({ provider: model, output: W, maxSteps: 1 }).send('w');
  log('repair at maxSteps=1', { fr: r.finishReason, calls: model.calls.length, obj: r.object });
}

// stream: run.done carries object (JSON-encoded?)
{
  const model = mockModel(['{"city":"Paris","tempC":21}']);
  const run = createAgent({ provider: model, output: W }).stream('x');
  let done: any;
  for await (const e of run) if (e.type === 'run.done') done = e;
  log('run.done.object', { type: typeof done.object, value: done.object });
  log('run.result.object', (await run.result).object);
}

// promptSchema false
{
  const model = mockModel(['{"city":"Paris","tempC":21}']);
  await createAgent({ provider: model, output: { schema: W, promptSchema: false } }).send('x');
  const sys = String(model.calls[0].messages[0].content);
  log('promptSchema:false sys', { hasOutputFormat: sys.includes('## Output format'), hasTempC: sys.includes('tempC'), rf: !!(model.calls[0].responseFormat as any)?.schema });
}

// session
{
  const model = mockModel(['{"city":"Paris","tempC":21}', '{"city":"Rome","tempC":25}']);
  const s = createAgent({ provider: model, output: W }).session();
  log('session send object', (await s.send('a')).object);
  log('session stream object', (await s.stream('b').result).object);
}

// executor snippet with createMockProvider
{
  const Ticket = z.object({ title: z.string(), priority: z.enum(['low', 'high']) });
  const agent = AgentBuilder.create().setName('triage').setPrompt('You triage bug reports.').build();
  const result = await AgentExecutor.execute({ agent, input: 'The app crashes on login', provider: createMockProvider(), output: Ticket });
  log('executor mock', { fr: result.finishReason, obj: result.object, text: String(result.text).slice(0, 100), err: (result as any).outputError?.message?.slice(0, 120) });
}

// sub-agent output: task tool result format
{
  const subModel = mockModel(['{"city":"Paris","tempC":21}']);
  const reporter = createAgent({ provider: subModel, description: 'Reports the weather', output: W });
  const leadModel = mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'reporter', subagent_type: 'reporter', description: 'w', prompt: 'Paris' } }] }, 'done']);
  const lead = createAgent({ provider: leadModel, subagents: { reporter } });
  const r = await lead.send('weather?');
  log('lead tools', leadModel.calls[0].tools?.map((t: any) => t.function.name));
  log('task params', JSON.stringify(leadModel.calls[0].tools?.find((t: any) => t.function.name === 'task')?.function.parameters).slice(0, 300));
  log('task result msg', String((leadModel.calls[1]?.messages.at(-1) as any)?.content).slice(0, 300));
  // invalid sub-agent output
  const sub2 = mockModel(['{"city":1}', '{"city":2}']);
  const reporter2 = createAgent({ provider: sub2, description: 'Reports', output: W });
  const lm2 = mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'reporter', subagent_type: 'reporter', description: 'w', prompt: 'Paris' } }] }, 'done']);
  await createAgent({ provider: lm2, subagents: { reporter: reporter2 } }).send('x');
  log('task invalid msg', String((lm2.calls[1]?.messages.at(-1) as any)?.content).slice(0, 400));
}
