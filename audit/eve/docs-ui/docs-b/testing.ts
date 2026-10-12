// Runtime checks for docs/testing.md claims.
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel, recordReplay, CassetteMismatchError } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));

// error turn: rejects, calls length 1
{
  const model = mockModel([{ error: new Error('upstream 503') }]);
  const agent = createAgent({ prompt: 'x', provider: model });
  const r = await agent.send('hi').then((x) => 'RESOLVED ' + JSON.stringify({ fr: x.finishReason, text: x.text }), (e) => 'rejected: ' + e.message);
  log('error-turn send', r);
  log('error-turn calls', model.calls.length);
  // stream result
  const model2 = mockModel([{ error: new Error('upstream 503') }]);
  const run = createAgent({ prompt: 'x', provider: model2 }).stream('hi');
  log('error-turn stream.result', await run.result.then((x) => 'RESOLVED ' + x.finishReason, (e) => 'rejected: ' + e.message));
  // 429-ish / retryable error
  const err: any = new Error('rate limited'); err.status = 503;
  const model3 = mockModel([{ error: err }], { onExhausted: 'repeat-last' });
  const r3 = await createAgent({ prompt: 'x', provider: model3 }).send('hi').then(() => 'resolved', (e) => 'rejected: ' + e.message);
  log('error-turn status503', { r3, calls: model3.calls.length });
}

// tool flow
{
  const calls: unknown[][] = [];
  const getWeather = defineTool({
    name: 'get_weather', description: 'Get the weather', input: z.object({ city: z.string() }),
    execute: async (...a: any[]) => { calls.push(a); return { city: a[0].city, tempC: 21 }; },
  });
  const model = mockModel([{ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, { text: 'It is 21°C in Paris.' }]);
  const agent = createAgent({ prompt: 'You report the weather.', provider: model, tools: [getWeather] });
  const result = await agent.send('Weather in Paris?');
  log('tool-flow text', result.text);
  log('tool-flow exec args', { first: calls[0][0], hasSecond: calls[0].length > 1 });
  log('tool-flow last msg', model.calls[1].messages.at(-1));
  log('tool-flow sys msg', model.calls[0].messages[0].role);
  log('tool-flow tools', model.lastCall?.tools?.map((t: any) => t.function?.name));
  model.assertExhausted();
  // frozen
  try { (model.calls[0] as any).messages.push({}); log('frozen', 'NOT frozen'); } catch { log('frozen', 'frozen ok'); }
}

// usage omitted -> estimated; finishReason defaults
{
  const model = mockModel(['hi']);
  const r = await model.generate({ messages: [{ role: 'user', content: 'x' }] } as any);
  log('usage omitted generate()', { usage: r.usage, fr: r.finishReason });
  const r2 = await mockModel([{ toolCalls: [{ name: 'a' }] }]).generate({ messages: [{ role: 'user', content: 'x' }] } as any);
  log('fr with tools', { fr: r2.finishReason, tc: r2.toolCalls });
}

// dynamic turns
{
  const model = mockModel([(req: any) => `You said: ${req.messages.at(-1)?.content}`]);
  const result = await model.generate({ messages: [{ role: 'user', content: 'ping' }] } as any);
  log('dynamic', result.text);
}

// exhaustion message
{
  const model = mockModel(['one']);
  await model.generate({ messages: [{ role: 'user', content: 'a' }] } as any);
  try { await model.generate({ messages: [{ role: 'user', content: 'second message' }] } as any); } catch (e: any) { log('exhausted msg', e.message); }
  model.reset();
  log('after reset calls', model.calls.length);
  try { model.assertExhausted(); log('assertExhausted after reset', 'no throw (BAD?)'); } catch (e: any) { log('assertExhausted after reset throws', e.message.slice(0, 120)); }
}

// stream chunks split on word boundaries
{
  const model = mockModel([{ text: 'Hello big world', toolCalls: [{ name: 'x', args: { a: 1 } }] }]);
  const s: any = await model.stream({ messages: [{ role: 'user', content: 'a' }] } as any);
  const chunks: any[] = [];
  for await (const c of s.fullStream) chunks.push(c);
  log('stream chunks', chunks.map((c) => c.type + (c.text != null ? `:${JSON.stringify(c.text)}` : c.textDelta != null ? `:${JSON.stringify(c.textDelta)}` : '')));
}

// recordReplay
{
  const dir = mkdtempSync(join(tmpdir(), 'cas-'));
  const cassette = join(dir, 'c.json');
  // replay without cassette
  try { recordReplay(undefined, { cassette, mode: 'replay' }); } catch (e: any) { log('replay missing (sync throw at construction)', e.code); }
  // record
  const rec = recordReplay(mockModel(['ok', 'ok2']), { cassette, mode: 'record', redact: (t) => t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>') });
  const ag = createAgent({ provider: rec, prompt: 'You handle refund requests.' });
  await ag.send('Refund order 1234 for bob@example.com key sk-abcdefghijklmnopqrstuvwxyz123456');
  log('recorded exists', existsSync(cassette));
  const raw = readFileSync(cassette, 'utf8');
  log('cassette redaction', { email: raw.includes('bob@example.com'), sk: raw.includes('sk-abcdef'), indent2: raw.split('\n')[1]?.startsWith('  ') && !raw.split('\n')[1]?.startsWith('   ') });
  // replay mismatch
  const rep = recordReplay(undefined, { cassette, mode: 'replay', redact: (t) => t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>') });
  const ag2 = createAgent({ provider: rep, prompt: 'You handle refund requests.' });
  log('replay same', await ag2.send('Refund order 1234 for bob@example.com key sk-abcdefghijklmnopqrstuvwxyz123456').then((r) => r.text, (e) => 'ERR ' + e.message));
  const rep2 = recordReplay(undefined, { cassette, mode: 'replay' });
  const ag3 = createAgent({ provider: rep2, prompt: 'You handle refund requests.' });
  await ag3.send('Refund order 9999').then((r) => log('replay diff', 'RESOLVED ' + r.text), (e) => log('replay diff', `${e instanceof CassetteMismatchError} ${e.code} ::\n${e.message}`));
  // re-record unchanged -> byte identical
  const before = readFileSync(cassette, 'utf8');
  await new Promise((r) => setTimeout(r, 1100));
  const rec2 = recordReplay(mockModel(['ok']), { cassette, mode: 'record', redact: (t) => t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>') });
  await createAgent({ provider: rec2, prompt: 'You handle refund requests.' }).send('Refund order 1234 for bob@example.com key sk-abcdefghijklmnopqrstuvwxyz123456');
  log('re-record unchanged byte-identical', before === readFileSync(cassette, 'utf8'));
  // auto mode
  const c2 = join(dir, 'auto.json');
  const a1 = recordReplay(() => mockModel(['auto-ok']), { cassette: c2, mode: 'auto' });
  log('auto record', (await a1.generate({ messages: [{ role: 'user', content: 'q' }] } as any)).text);
  let factoryCalled = false;
  const a2 = recordReplay(() => { factoryCalled = true; return mockModel(['other']); }, { cassette: c2, mode: 'auto' });
  log('auto replay', { text: (await a2.generate({ messages: [{ role: 'user', content: 'q' }] } as any)).text, factoryCalled });
}
