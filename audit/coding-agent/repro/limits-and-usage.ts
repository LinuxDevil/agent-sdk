/**
 * Deterministic (mockModel) probes of: maxSteps when the model loops, usage
 * across an approval pause, usage of a run that fails mid-way, and hook deny
 * vs tool guardrail block.
 *   npx tsx coding-agent/repro/limits-and-usage.ts
 */
import { createAgent, createFsTools, createShellTool, MemoryWorkspace, type AgentHook, type IoGuardrail } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const ws = () => new MemoryWorkspace({ files: { 'src/a.js': 'x\n' }, exec: () => ({ stdout: 'ok\n' }) });
const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

// 1. A model that loops on the same call.
{
  const loop = mockModel([{ toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }], usage: u(100, 10) }], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: loop, tools: createFsTools(ws()), maxSteps: 5 });
  const r = await agent.send('fix it');
  console.log(`1a maxSteps=5, looping model: finishReason=${r.finishReason} steps=${r.steps} modelCalls=${r.usage?.modelCalls} tokens=${r.usage?.totalTokens} text=${JSON.stringify(r.text)}`);

  const guard: AgentHook = { name: 'loop-guard', preToolCall: (() => { let n = 0; return () => (++n > 2 ? { deny: 'stop repeating' } : undefined); })() };
  const loop2 = mockModel([{ toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }], usage: u(100, 10) }], { onExhausted: 'repeat-last' });
  const r2 = await createAgent({ provider: loop2, tools: createFsTools(ws()), maxSteps: 5, hooks: [guard] }).send('fix it');
  console.log(`1b + loop-guard hook denying after 2: finishReason=${r2.finishReason} steps=${r2.steps} (hook deny is fed back; the model keeps looping until maxSteps)`);

  const loop3 = mockModel([{ toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }], usage: u(100, 10) }], { onExhausted: 'repeat-last' });
  const r3 = await createAgent({ provider: loop3, tools: createFsTools(ws()), limits: { maxSteps: 4 } }).send('fix it');
  console.log(`1c limits.maxSteps=4 (budget) instead: finishReason=${r3.finishReason} steps=${r3.steps}`);
}

// 2. Usage across an approval pause.
{
  const m = mockModel([
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }], usage: u(1000, 10) },
    { text: 'fixed', usage: u(2000, 20) },
  ]);
  const agent = createAgent({ provider: m, tools: [createShellTool(ws())] });
  const paused = await agent.send('run tests');
  const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
  console.log(`2  paused.usage.totalTokens=${paused.usage?.totalTokens} resumed.usage.totalTokens=${done.usage?.totalTokens} modelCalls=${done.usage?.modelCalls} (whole task = 3030)`);
}

// 3. Usage of a run that fails after spending tokens.
{
  const m = mockModel([
    { toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }], usage: u(3000, 300) },
    { toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }], usage: u(3500, 300) },
    { error: Object.assign(new Error('Context size has been exceeded.'), { statusCode: 500 }) },
  ]);
  let lastDone: unknown;
  const agent = createAgent({ provider: m, tools: createFsTools(ws()), onEvent: (e) => { if (e.type === 'run.done') lastDone = e.usage; } });
  try {
    await agent.send('fix it');
  } catch (error) {
    const e = error as Error & Record<string, unknown>;
    console.log(`3  send() rejected: ${e.name} code=${e.code} usage on error=${JSON.stringify(e.usage)} result=${JSON.stringify((e as { result?: unknown }).result)?.slice(0, 60)}; run.done usage=${JSON.stringify(lastDone)} (7100 tokens were spent)`);
  }
}

// 4. Hook deny vs tool guardrail block on the same bad edit.
{
  const script = () => mockModel([
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/a.js', old_string: 'x', new_string: 'process.exit(0)' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'src/a.js' } }] },
    'gave up',
  ]);
  const hook: AgentHook = { name: 'no-exit', preToolCall: (c) => (String(c.args.new_string ?? '').includes('process.exit') ? { deny: 'process.exit is not allowed' } : undefined) };
  const rail: IoGuardrail = { name: 'no-exit', check: ({ text }) => (text.includes('process.exit') ? { ok: false, reason: 'process.exit is not allowed' } : { ok: true }) };
  const a = await createAgent({ provider: script(), tools: createFsTools(ws()), hooks: [hook] }).send('go');
  const b = await createAgent({ provider: script(), tools: createFsTools(ws()), guardrails: { tools: [rail] } }).send('go');
  console.log(`4  hook deny: finishReason=${a.finishReason} steps=${a.steps} text=${JSON.stringify(a.text)}`);
  console.log(`4  tool guardrail: finishReason=${b.finishReason} steps=${b.steps} guardrail=${JSON.stringify(b.guardrail)}`);
}
