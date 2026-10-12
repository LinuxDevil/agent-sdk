// Runtime checks for docs/handoffs.md claims.
import { createAgent, defineTool, handoff, handoffFilters } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));
const short = (msgs: readonly any[]) => msgs.map((m) => `${m.role}${m.metadata?.handoff ? '(handoff)' : ''}:${String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 60)}${m.toolCalls ? ' +calls' : ''}`);

// Quick start
{
  const lookupCharges = defineTool({ name: 'lookup_charges', description: 'Lists charges', input: z.object({}), execute: async () => [{ amountUsd: 9.99 }] });
  const bm = mockModel(['Billing: refund issued.']);
  const tm = mockModel(['tech']);
  const billing = createAgent({ name: 'billing', description: 'Handles charges', instructions: 'You are the billing desk.', provider: bm, tools: [lookupCharges] });
  const tech = createAgent({ name: 'tech-support', description: 'Handles logins', provider: tm });
  const trm = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'double charge' } }] }]);
  const triage = createAgent({ name: 'triage', instructions: 'Route.', provider: trm, handoffs: [billing, tech] });
  const events: any[] = [];
  const result = await triage.send('I was charged twice.', {});
  log('qs agentName/text', { agentName: (result as any).agentName, text: result.text });
  log('qs triage tools', trm.calls[0].tools?.map((t: any) => t.function.name));
  log('qs billing request', short(bm.calls[0].messages));
  log('qs billing tools', bm.calls[0].tools?.map((t: any) => t.function.name));
  log('qs result.messages', short((result as any).messages ?? []));
}

// Validation at createAgent
{
  const noDesc = createAgent({ name: 'x', provider: mockModel(['a']) });
  try { createAgent({ name: 't', provider: mockModel(['a']), handoffs: [noDesc] }); log('no description', 'NO THROW'); } catch (e: any) { log('no description', `${e.code}: ${e.message.slice(0, 120)}`); }
  const noName = createAgent({ description: 'y', provider: mockModel(['a']) });
  try { createAgent({ name: 't', provider: mockModel(['a']), handoffs: [noName] }); log('no name', 'NO THROW'); } catch (e: any) { log('no name', `${e.code}: ${e.message.slice(0, 120)}`); }
  const a1 = createAgent({ name: 'dup', description: 'd', provider: mockModel(['a']) });
  const a2 = createAgent({ name: 'dup', description: 'd2', provider: mockModel(['a']) });
  try { createAgent({ name: 't', provider: mockModel(['a']), handoffs: [a1, a2] }); log('dup names', 'NO THROW'); } catch (e: any) { log('dup names', `${e.code}: ${e.message.slice(0, 120)}`); }
  const clash = defineTool({ name: 'transfer_to_dup', description: 'x', input: z.object({}), execute: async () => 1 });
  try { createAgent({ name: 't', provider: mockModel(['a']), handoffs: [a1], tools: [clash] }); log('tool name clash', 'NO THROW'); } catch (e: any) { log('tool name clash', `${e.code}: ${e.message.slice(0, 120)}`); }
  // a name that is invalid as a tool name for OpenAI (spaces)
  const spaced = createAgent({ name: 'Billing Desk', description: 'd', provider: mockModel(['a']) });
  try {
    const m = mockModel([{ text: 'ok' }]);
    await createAgent({ name: 't', provider: m, handoffs: [spaced] }).send('x');
    log('spaced name tool', m.calls[0].tools?.map((t: any) => t.function.name));
  } catch (e: any) { log('spaced name', `${e.code}: ${e.message.slice(0, 120)}`); }
}

// handoff() options: input validation, isEnabled, onHandoff, toolName
{
  const rm = mockModel(['refund done']);
  const refunds = createAgent({ name: 'refunds', description: 'Issues refunds', provider: rm });
  const seen: any[] = [];
  const mk = (tm: any) => createAgent({
    name: 'triage', provider: tm,
    handoffs: [handoff(refunds, {
      toolName: 'escalate_refund', description: 'money back', input: z.object({ orderId: z.string() }),
      inputFilter: handoffFilters.removeToolCalls,
      onHandoff: (d: any) => seen.push({ from: d.from, to: d.to, args: d.args, sessionId: d.sessionId, n: d.messages?.length }),
      isEnabled: ({ metadata }: any) => metadata?.plan === 'pro',
    })],
  });
  const t1 = mockModel(['no handoff offered']);
  await mk(t1).send('refund', { metadata: { plan: 'free' } });
  log('isEnabled false tools', t1.calls[0].tools?.map((t: any) => t.function.name) ?? []);
  const t2 = mockModel([{ toolCalls: [{ name: 'escalate_refund', args: { order: 1 } }] }, 'I answered myself']);
  const r2 = await mk(t2).send('refund', { metadata: { plan: 'pro' } });
  log('bad args', { agentName: (r2 as any).agentName, text: r2.text, toolMsg: String((t2.calls[1]?.messages.at(-1) as any)?.content).slice(0, 200) });
  const t3 = mockModel([{ toolCalls: [{ name: 'escalate_refund', args: { orderId: 'A1' } }] }]);
  const r3 = await mk(t3).send('refund', { metadata: { plan: 'pro' } });
  log('good args', { agentName: (r3 as any).agentName, text: r3.text, onHandoff: seen });
  log('refunds request (removeToolCalls)', short(rm.calls.at(-1)!.messages));
}

// inputFilter data + mid-conversation system messages + lastUserMessage + empty filter
{
  let data: any;
  const bm = mockModel(['b1']);
  const billing = createAgent({ name: 'billing', description: 'd', provider: bm });
  const tm = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'x' } }] }]);
  await createAgent({ name: 'triage', provider: tm, handoffs: [handoff(billing, { inputFilter: (d) => { data = d; return d.messages; } })] }).send('hello');
  log('filter data', { keys: Object.keys(data), from: data.from, to: data.to, args: data.args, msgs: short(data.messages) });
  log('target request roles', bm.calls[0].messages.map((m: any) => m.role));
  log('target sys tail', String(bm.calls[0].messages[0].content).slice(-160));

  const bm2 = mockModel(['b2']);
  const billing2 = createAgent({ name: 'billing', description: 'd', provider: bm2 });
  const tm2 = mockModel([{ toolCalls: [{ name: 'transfer_to_billing' }] }]);
  await createAgent({ name: 'triage', provider: tm2, handoffs: [handoff(billing2, { inputFilter: handoffFilters.lastUserMessage })] }).send('only me');
  log('lastUserMessage request', short(bm2.calls[0].messages));

  const billing3 = createAgent({ name: 'billing', description: 'd', provider: mockModel(['b3']) });
  const tm3 = mockModel([{ toolCalls: [{ name: 'transfer_to_billing' }] }, 'fallback']);
  const r = await createAgent({ name: 'triage', provider: tm3, handoffs: [handoff(billing3, { inputFilter: () => [] })] }).send('x').then((x) => `resolved ${x.finishReason} ${(x as any).agentName} ${x.text}`, (e) => `rejected ${e.code}: ${e.message.slice(0, 140)}`);
  log('empty filter', r);
}

// sessions: billing stays active
{
  const bm = mockModel(['b-first', 'b-second']);
  const billing = createAgent({ name: 'billing', description: 'd', provider: bm });
  const tm = mockModel([{ toolCalls: [{ name: 'transfer_to_billing' }] }]);
  const triage = createAgent({ name: 'triage', provider: tm, handoffs: [billing] });
  const s = triage.session();
  const a = await s.send('I was charged twice.');
  const b = await s.send('Can you refund one?');
  log('session', { first: (a as any).agentName, next: (b as any).agentName, nextText: b.text, triageCalls: tm.calls.length });
  const c = await triage.send('fresh').then((x) => (x as any).agentName, (e) => 'ERR ' + e.message.slice(0, 100));
  log('agent.send starts at lead', c);
}

// events ordering
{
  const billing = createAgent({ name: 'billing', description: 'd', provider: mockModel(['ok']) });
  const triage = createAgent({ name: 'triage', provider: mockModel([{ toolCalls: [{ name: 'transfer_to_billing' }] }]), handoffs: [billing] });
  const types: string[] = [];
  for await (const e of triage.stream('x')) types.push(e.type === 'handoff' ? `handoff(${(e as any).from}->${(e as any).to},${(e as any).toolCallId})` : e.type);
  log('events', types);
}

// two handoffs in one turn
{
  const a = createAgent({ name: 'a', description: 'd', provider: mockModel(['from a']) });
  const b = createAgent({ name: 'b', description: 'd', provider: mockModel(['from b']) });
  const r = await createAgent({ name: 't', provider: mockModel([{ toolCalls: [{ name: 'transfer_to_b' }, { name: 'transfer_to_a' }] }]), handoffs: [a, b] }).send('x');
  log('two handoffs', { agentName: (r as any).agentName, text: r.text });
}

// maxHandoffs default 5: ping-pong
{
  const aH: any[] = [];
  const am = mockModel([{ toolCalls: [{ name: 'transfer_to_b' }] }], { onExhausted: 'repeat-last' });
  const bm = mockModel([{ toolCalls: [{ name: 'transfer_to_a' }] }], { onExhausted: 'repeat-last' });
  const a = createAgent({ name: 'a', description: 'A', provider: am, handoffs: aH, maxSteps: 30 });
  const b = createAgent({ name: 'b', description: 'B', provider: bm, handoffs: [a] });
  aH.push(b);
  const types: string[] = [];
  const run = a.stream('go', { } as any);
  let handoffs = 0;
  for await (const e of run) { if (e.type === 'handoff') handoffs++; }
  const r = await run.result;
  log('ping-pong', { handoffs, fr: r.finishReason, calls: am.calls.length + bm.calls.length, lastToolMsg: String((bm.calls.at(-1)?.messages.at(-1) as any)?.content ?? (am.calls.at(-1)?.messages.at(-1) as any)?.content).slice(0, 160) });
}

// output: lead's schema governs; target's output not used
{
  const target = createAgent({ name: 'billing', description: 'd', provider: mockModel(['{"amount":5}'], { onExhausted: 'repeat-last' }), output: z.object({ amount: z.number() }) });
  const r = await createAgent({ name: 't', provider: mockModel([{ toolCalls: [{ name: 'transfer_to_billing' }] }]), handoffs: [target], output: z.object({ city: z.string() }) }).send('x');
  log('output lead schema', { fr: r.finishReason, obj: r.object, err: r.outputError?.message?.slice(0, 80) });
}

// warning on target with run-level options
{
  const warns: string[] = [];
  const ow = console.warn; console.warn = (...a: any[]) => warns.push(a.join(' '));
  const target = createAgent({ name: 'billing', description: 'd', provider: mockModel(['x']), approve: () => true } as any);
  createAgent({ name: 't', provider: mockModel(['x']), handoffs: [target] });
  createAgent({ name: 't2', provider: mockModel(['x']), handoffs: [target] });
  console.warn = ow;
  log('warns', warns.map((w) => w.slice(0, 160)));
}
