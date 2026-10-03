/**
 * N14: code mode, offline with mockModel. The scripted model returns a
 * `run_code` call with fixed code; each test checks what the script could do,
 * what the gate did with its inner calls, and what reached the model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import type { ExecutionResult } from './AgentExecutor';
import type { Message } from '../providers';
import type { Span, TraceExporter } from './tracing';
import { allow, ask, deny } from './permissions';
import type { IoGuardrail } from './ioGuardrails';
import { ALICE, fakeOAuthServer, githubProvider, listReposTool } from '../oauth/__fixtures__/fakeOAuth';
import { loadQuickJS, runScript, ScriptError, type ScriptHost } from './codeModeIsolate';

afterEach(() => vi.restoreAllMocks());

const PRICES: Record<string, number> = { apple: 1.5, pear: 2, plum: 0.75 };
const RATES: Record<string, number> = { EUR: 0.5, USD: 1 };

/** `get_price` and `convert` with fixed tables; `calls` records every execution. */
function shopTools() {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const getPrice = defineTool({
    name: 'get_price',
    description: 'Price of an item in USD',
    input: z.object({ item: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ item }) => {
      calls.push({ tool: 'get_price', args: { item } });
      if (!(item in PRICES)) throw new Error(`Unknown item '${item}'`);
      return { item, usd: PRICES[item] };
    },
  });
  const convert = defineTool({
    name: 'convert',
    description: 'Converts USD to another currency',
    input: z.object({ amount: z.number(), to: z.enum(['EUR', 'USD']) }),
    execute: async ({ amount, to }) => {
      calls.push({ tool: 'convert', args: { amount, to } });
      return { amount: amount * RATES[to], currency: to };
    },
  });
  return { getPrice, convert, calls };
}

/** A model that calls run_code once with `code`, then answers `final`. */
function scripted(code: string, final = 'Done.'): MockModel {
  return mockModel([{ toolCalls: [{ name: 'run_code', id: 'call_code', args: { code } }] }, final]);
}

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

/** The parsed `tool` message of `id`. */
function toolResult(messages: readonly Message[], id = 'call_code'): { result?: unknown; logs?: string[]; toolCalls?: number; message?: string; error?: string } {
  const message = messages.find((m) => m.role === 'tool' && m.toolCallId === id);
  if (!message) throw new Error(`no tool message for ${id}`);
  return JSON.parse(String(message.content)) as never;
}

const names = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is AgentEventOf<T> => e.type === type);

const TOTAL = `
  let usd = 0;
  for (const item of ['apple', 'pear', 'plum']) usd += (await tools.get_price({ item })).usd;
  const eur = await tools.convert({ amount: usd, to: 'EUR' });
  return { usd, eur: eur.amount };
`;

describe('code mode (N14): run_code', () => {
  it('a script calls two tools in a loop and returns a combined value; the model sees only run_code\'s result', async () => {
    const { getPrice, convert, calls } = shopTools();
    const model = scripted(TOTAL);
    const agent = createAgent({ provider: model, tools: [getPrice, convert], codeMode: true });
    const { events, result } = await collect(agent.stream('What do they cost?'));

    expect(result.finishReason).toBe('stop');
    expect(toolResult(result.messages)).toEqual({ result: { usd: 4.25, eur: 2.125 }, logs: [], toolCalls: 4 });
    expect(calls.map((c) => c.tool)).toEqual(['get_price', 'get_price', 'get_price', 'convert']);
    // The second model request: the run_code call and its one result, no inner call.
    const second = model.calls[1].messages;
    expect(second.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_code']);
    expect(second.flatMap((m) => m.toolCalls ?? []).map((c) => c.id)).toEqual(['call_code']);
    expect(JSON.stringify(second)).not.toContain('"item":"apple","usd"');
    // Inner calls are reported, tagged with their parent, and settle before run_code does.
    const starts = ofType(events, 'tool.start');
    expect(starts.map((e) => [e.toolCallId, e.toolName, e.parentToolCallId])).toEqual([
      ['call_code', 'run_code', undefined],
      ['call_code:1', 'get_price', 'call_code'],
      ['call_code:2', 'get_price', 'call_code'],
      ['call_code:3', 'get_price', 'call_code'],
      ['call_code:4', 'convert', 'call_code'],
    ]);
    const done = ofType(events, 'tool.done');
    expect(done.map((e) => [e.toolCallId, e.parentToolCallId])).toEqual([
      ['call_code:1', 'call_code'],
      ['call_code:2', 'call_code'],
      ['call_code:3', 'call_code'],
      ['call_code:4', 'call_code'],
      ['call_code', undefined],
    ]);
    expect(done[0].result).toEqual({ item: 'apple', usd: 1.5 });
  });

  it('describes each allowed tool with a signature from its input schema', async () => {
    const { getPrice, convert } = shopTools();
    const model = scripted('return 1');
    await createAgent({ provider: model, tools: [getPrice, convert], codeMode: true }).send('x');
    const description = model.calls[0].tools?.find((t) => t.function.name === 'run_code')?.function.description ?? '';
    expect(description).toContain('// Price of an item in USD\ntools.get_price(args: { item: string }): Promise<unknown>');
    expect(description).toContain('tools.convert(args: { amount: number; to: "EUR" | "USD" }): Promise<unknown>');
    expect(description).toContain('30000 ms, 50 tool calls, 20000 characters of output');
    expect(names(model, 0)).toEqual(['get_price', 'convert', 'run_code']);
  });

  it('a pre-tool hook and a permission rule apply to inner calls', async () => {
    const { getPrice, convert, calls } = shopTools();
    const seen: string[] = [];
    const model = scripted(`
      const price = await tools.get_price({ item: 'APPLE' });
      let denied;
      try { await tools.convert({ amount: 1, to: 'EUR' }); } catch (error) { denied = error.message; }
      return { price, denied };
    `);
    const agent = createAgent({
      provider: model,
      tools: [getPrice, convert],
      codeMode: true,
      permissions: [deny('convert', 'No conversions today')],
      hooks: [
        {
          name: 'lowercase',
          preToolCall: (ctx) => {
            seen.push(`${ctx.toolCallId} ${ctx.toolName}`);
            if (typeof ctx.args.item === 'string') ctx.args.item = ctx.args.item.toLowerCase();
          },
        },
      ],
    });
    const result = await agent.send('x');

    expect(toolResult(result.messages).result).toEqual({
      price: { item: 'apple', usd: 1.5 },
      denied: "Tool 'convert' was denied by a permission rule: No conversions today",
    });
    expect(seen).toEqual(['call_code run_code', 'call_code:1 get_price', 'call_code:2 convert']);
    expect(calls).toEqual([{ tool: 'get_price', args: { item: 'apple' } }]);
  });

  it('an inner call to a needsApproval tool rejects inside the script and the run does not pause', async () => {
    const executed = vi.fn();
    const pay = defineTool({ name: 'pay', description: 'Pays', input: z.object({ amount: z.number() }), needsApproval: true, execute: executed });
    const model = scripted(`try { await tools.pay({ amount: 5 }); return 'paid'; } catch (error) { return error.message; }`);
    const agent = createAgent({ provider: model, tools: [pay], codeMode: true });
    const { events, result } = await collect(agent.stream('pay'));

    expect(result.finishReason).toBe('stop');
    expect(toolResult(result.messages).result).toBe('Tool pay needs approval; call it directly, not from run_code.');
    expect(executed).not.toHaveBeenCalled();
    expect(await agent.approvals.list()).toEqual([]);
    expect(ofType(events, 'approval.requested')).toEqual([]);
    expect(ofType(events, 'tool.error')).toMatchObject([{ toolCallId: 'call_code:1', parentToolCallId: 'call_code', error: { message: 'Tool pay needs approval; call it directly, not from run_code.' } }]);
  });

  it('a tool not in codeMode.tools is not on the tools object', async () => {
    const { getPrice, convert, calls } = shopTools();
    const model = scripted(`return { keys: Object.keys(tools), convert: typeof tools.convert };`);
    const result = await createAgent({ provider: model, tools: [getPrice, convert], codeMode: { tools: ['get_price'] } }).send('x');
    expect(toolResult(result.messages).result).toEqual({ keys: ['get_price'], convert: 'undefined' });
    expect(model.calls[0].tools?.find((t) => t.function.name === 'run_code')?.function.description).not.toContain('tools.convert');
    expect(calls).toEqual([]);
  });

  it('by default leaves out ask_question and deferred tools', async () => {
    const { getPrice } = shopTools();
    const hidden = defineTool({ name: 'rare_tool', description: 'Rarely needed', input: z.object({}), deferLoading: true, execute: async () => 'rare' });
    const model = scripted(`return Object.keys(tools);`);
    const agent = createAgent({ provider: model, tools: [getPrice, hidden], askQuestion: true, toolSearch: { thresholdPercent: 0 }, codeMode: true });
    const result = await agent.send('x');
    expect(toolResult(result.messages).result).toEqual(['get_price']);
  });

  it('a deferred tool named in codeMode.tools is callable from scripts', async () => {
    const hidden = defineTool({ name: 'rare_tool', description: 'Rarely needed', input: z.object({}), deferLoading: true, execute: async () => 'rare' });
    const model = scripted(`return await tools.rare_tool({});`);
    const agent = createAgent({ provider: model, tools: [hidden], toolSearch: { thresholdPercent: 0 }, codeMode: { tools: ['rare_tool'] } });
    const result = await agent.send('x');
    expect(toolResult(result.messages).result).toBe('rare');
    // Still withheld from the model's own tool list.
    expect(names(model, 0)).toEqual(['tool_search', 'run_code']);
  });

  it('exclusive: true hides the tools from the model, scripts still call them', async () => {
    const { getPrice, convert } = shopTools();
    const model = scripted(TOTAL);
    const result = await createAgent({ provider: model, tools: [getPrice, convert], codeMode: { exclusive: true } }).send('x');
    expect(names(model, 0)).toEqual(['run_code']);
    expect(names(model, 1)).toEqual(['run_code']);
    expect(toolResult(result.messages).result).toEqual({ usd: 4.25, eur: 2.125 });
  });

  it('console.log lines are captured', async () => {
    const model = scripted(`console.log('hello', 1, { a: [1] }); console.error('bad'); console.warn(new Error('w')); return null;`);
    const result = await createAgent({ provider: model, codeMode: true }).send('x');
    expect(toolResult(result.messages)).toEqual({ result: null, logs: ['hello 1 {"a":[1]}', '[error] bad', '[warn] Error: w'], toolCalls: 0 });
  });

  it('a thrown script error is a tool error naming it', async () => {
    const model = scripted(`const x = null; return x.y;`);
    const { events, result } = await collect(createAgent({ provider: model, codeMode: true }).stream('x'));
    const error = toolResult(result.messages);
    expect(error.error).toBe('ScriptError');
    expect(error.message).toMatch(/^run_code failed: the script threw TypeError: cannot read property 'y' of null/);
    expect(ofType(events, 'tool.error')).toHaveLength(1);
    expect(result.finishReason).toBe('stop');
  });

  it('a script error lists the first tool calls and their results (clipped), so the model can fix the script', async () => {
    const { getPrice, convert } = shopTools();
    const model = scripted(`const a = await tools.get_price({ item: 'apple' }); return await tools.convert({ amount: a.price, to: 'EUR' });`);
    const result = await createAgent({ provider: model, tools: [getPrice, convert], codeMode: true }).send('x');
    const { message = '' } = toolResult(result.messages);
    expect(message).toMatch(/^run_code failed: the script threw ToolError: Invalid arguments for tool 'convert'/);
    expect(message).toContain('Tool calls before the error:\n- tools.get_price({"item":"apple"}) returned {"item":"apple","usd":1.5}\n- tools.convert({"to":"EUR"}) threw Invalid arguments');
  });

  it('a syntax error and a non-serializable return value are tool errors', async () => {
    const syntax = await createAgent({ provider: scripted(`return {`), codeMode: true }).send('x');
    expect(toolResult(syntax.messages).message).toMatch(/SyntaxError/);
    const cyclic = await createAgent({ provider: scripted(`const a = {}; a.a = a; return a;`), codeMode: true }).send('x');
    expect(toolResult(cyclic.messages).message).toMatch(/run_code failed: the script threw TypeError/);
  });

  it('a tool error reaches the script as an Error with the message only (no host stack)', async () => {
    const { getPrice } = shopTools();
    const model = scripted(`try { await tools.get_price({ item: 'kiwi' }); } catch (e) { return { name: e.name, message: e.message, stack: e.stack, isError: e instanceof Error }; }`);
    const result = await createAgent({ provider: model, tools: [getPrice], codeMode: true }).send('x');
    const caught = toolResult(result.messages).result as { name: string; message: string; stack: string; isError: boolean };
    expect(caught).toMatchObject({ name: 'ToolError', message: "Unknown item 'kiwi'", isError: true });
    expect(caught.stack).not.toMatch(/codeMode\.test|node_modules|[A-Z]:\\|\/src\//);
  });

  it('invalid arguments from a script are validated like the model\'s', async () => {
    const { getPrice, calls } = shopTools();
    const model = scripted(`try { await tools.get_price({ item: 42 }); } catch (e) { return e.message; }`);
    const result = await createAgent({ provider: model, tools: [getPrice], codeMode: true }).send('x');
    expect(toolResult(result.messages).result).toMatch(/get_price/);
    expect(calls).toEqual([]);
  });

  it('values cross the boundary as JSON copies', async () => {
    const received: unknown[] = [];
    const shared = { list: [1, 2], when: new Date('2026-01-02T03:04:05Z'), fn: () => 1, big: undefined };
    const echo = defineTool({
      name: 'echo',
      description: 'Echoes',
      input: z.object({ value: z.unknown() }),
      execute: async ({ value }) => {
        received.push(value);
        return shared;
      },
    });
    const model = scripted(`
      const out = await tools.echo({ value: { n: 1, skip: undefined, f: () => 2 } });
      out.list.push(3);
      return { out, keys: Object.keys(out) };
    `);
    const result = await createAgent({ provider: model, tools: [echo], codeMode: true }).send('x');
    expect(received).toEqual([{ n: 1 }]);
    expect(toolResult(result.messages).result).toEqual({ out: { list: [1, 2, 3], when: '2026-01-02T03:04:05.000Z' }, keys: ['list', 'when'] });
    expect(shared.list).toEqual([1, 2]);
  });
});

describe('code mode (N14): limits', () => {
  it('maxToolCalls exceeded is a tool error, even when the script catches it', async () => {
    const { getPrice, calls } = shopTools();
    const model = scripted(`for (let i = 0; i < 5; i++) { try { await tools.get_price({ item: 'apple' }); } catch {} } return 'kept going';`);
    const result = await createAgent({ provider: model, tools: [getPrice], codeMode: { maxToolCalls: 2 } }).send('x');
    expect(toolResult(result.messages).message).toBe('run_code stopped: the script made more than maxToolCalls (2) tool calls.');
    expect(calls).toHaveLength(2);
  });

  it('an infinite loop stops at timeoutMs and the host goes on', async () => {
    const model = scripted(`for (;;) {}`);
    const timer = vi.fn();
    setTimeout(timer, 10);
    const started = Date.now();
    const result = await createAgent({ provider: model, codeMode: { timeoutMs: 300 } }).send('x');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(toolResult(result.messages).message).toMatch(/^run_code stopped: the script ran longer than timeoutMs \(300 ms\)/);
    expect(result.finishReason).toBe('stop');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timer).toHaveBeenCalled();
  });

  it('an uncatchable stop: try/catch around an infinite loop does not keep it running', async () => {
    const result = await createAgent({ provider: scripted(`try { for (;;) {} } catch { return 'caught'; }`), codeMode: { timeoutMs: 200 } }).send('x');
    expect(toolResult(result.messages).message).toMatch(/timeoutMs \(200 ms\)/);
  });

  it('timeoutMs counts the tool calls the script awaits; the call in flight is aborted and settles before run_code', async () => {
    let aborted = false;
    const slow = defineTool({
      name: 'slow',
      description: 'Slow',
      input: z.object({}),
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            setTimeout(() => resolve('late'), 20);
          });
        }),
    });
    const model = scripted(`return await tools.slow({});`);
    const { events, result } = await collect(createAgent({ provider: model, tools: [slow], codeMode: { timeoutMs: 150 } }).stream('x'));
    expect(toolResult(result.messages).message).toMatch(/timeoutMs \(150 ms\)/);
    expect(aborted).toBe(true);
    const settled = events.filter((e) => e.type === 'tool.done' || e.type === 'tool.error').map((e) => (e as AgentEventOf<'tool.done'>).toolCallId);
    expect(settled).toEqual(['call_code:1', 'call_code']);
  });

  it('a large allocation stops at memoryLimitBytes', async () => {
    const model = scripted(`const parts = []; for (;;) parts.push('x'.repeat(1024) + parts.length);`);
    const result = await createAgent({ provider: model, codeMode: { memoryLimitBytes: 8 * 1024 * 1024 } }).send('x');
    expect(toolResult(result.messages).message).toBe('run_code stopped: the script used more than memoryLimitBytes (8388608 bytes).');
  });

  it('a returned value over maxOutputChars is a tool error; logs are cut to what is left', async () => {
    const big = await createAgent({ provider: scripted(`return 'x'.repeat(200);`), codeMode: { maxOutputChars: 100 } }).send('x');
    expect(toolResult(big.messages).message).toMatch(/return value is 202 characters of JSON, over maxOutputChars \(100\)/);
    const chatty = await createAgent({ provider: scripted(`for (let i = 0; i < 50; i++) console.log('line ' + i); return 'ok';`), codeMode: { maxOutputChars: 40 } }).send('x');
    const { result, logs = [] } = toolResult(chatty.messages);
    expect(result).toBe('ok');
    expect(logs.join('').length).toBeLessThan(120);
    expect(logs.at(-1)).toMatch(/logs truncated/);
  });

  it('a promise that never settles is a tool error, not a hang', async () => {
    const result = await createAgent({ provider: scripted(`await new Promise(() => {}); return 1;`), codeMode: true }).send('x');
    expect(toolResult(result.messages).message).toMatch(/never settles/);
  });

  it('aborting the run stops a script waiting for a tool', async () => {
    const controller = new AbortController();
    const slow = defineTool({ name: 'slow', description: 'Slow', input: z.object({}), execute: (_a, ctx) => new Promise((resolve) => ctx.abortSignal?.addEventListener('abort', () => resolve('stopped'))) });
    const run = createAgent({ provider: scripted(`return await tools.slow({});`), tools: [slow], codeMode: true }).send('x', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await run;
    expect(result.finishReason).toBe('aborted');
  });
});

describe('code mode (N14): the isolate has no host access', () => {
  it('require, process, fetch, timers and host globals are undefined; import() is rejected', async () => {
    const model = scripted(`
      let imported;
      try { await import('node:fs'); imported = 'loaded'; } catch (e) { imported = e.message; }
      const indirect = (0, eval)('this');
      return {
        require: typeof require, process: typeof process, fetch: typeof fetch, setTimeout: typeof setTimeout,
        setInterval: typeof setInterval, queueMicrotask: typeof queueMicrotask, Buffer: typeof Buffer, globalProcess: typeof globalThis.process,
        hostCall: typeof globalThis.__lousho_call, hostLog: typeof globalThis.__lousho_log, viaFunction: typeof Function('return this')().process,
        indirect: typeof indirect.require, imported,
        globals: Object.getOwnPropertyNames(globalThis).filter((k) => /^(require|process|fetch|module|exports|__)/.test(k)),
      };
    `);
    const result = await createAgent({ provider: model, codeMode: true }).send('x');
    expect(toolResult(result.messages).result).toEqual({
      require: 'undefined', process: 'undefined', fetch: 'undefined', setTimeout: 'undefined',
      setInterval: 'undefined', queueMicrotask: 'undefined', Buffer: 'undefined', globalProcess: 'undefined',
      hostCall: 'undefined', hostLog: 'undefined', viaFunction: 'undefined', indirect: 'undefined',
      imported: "could not load module 'node:fs'",
      globals: [],
    });
  });

  it('the tools object cannot be changed by the script', async () => {
    const { getPrice } = shopTools();
    const model = scripted(`'use strict'; try { tools.get_price = 1; } catch (e) { return [e.name, typeof tools.get_price]; } return 'changed';`);
    const result = await createAgent({ provider: model, tools: [getPrice], codeMode: true }).send('x');
    expect(toolResult(result.messages).result).toEqual(['TypeError', 'function']);
  });
});

describe('code mode (N14): every inner call passes the run\'s gate', () => {
  it('plan mode refuses non-read-only inner calls; read-only ones and run_code itself run', async () => {
    const { getPrice, convert, calls } = shopTools();
    const model = scripted(`
      const price = await tools.get_price({ item: 'pear' });
      try { await tools.convert({ amount: 1, to: 'EUR' }); } catch (e) { return { price, refused: e.message }; }
    `);
    const result = await createAgent({ provider: model, tools: [getPrice, convert], codeMode: true, permissionMode: 'plan' }).send('x');
    const { price, refused } = toolResult(result.messages).result as { price: unknown; refused: string };
    expect(price).toEqual({ item: 'pear', usd: 2 });
    expect(refused).toMatch(/^Tool 'convert' was denied by plan mode/);
    expect(calls.map((c) => c.tool)).toEqual(['get_price']);
  });

  it('permission.decision events audit inner calls under their own ids', async () => {
    const { getPrice, convert } = shopTools();
    const model = scripted(`await tools.get_price({ item: 'plum' }); return 1;`);
    const { events } = await collect(createAgent({ provider: model, tools: [getPrice, convert], codeMode: true, permissions: [allow('get_price'), allow('run_code')] }).stream('x'));
    expect(ofType(events, 'permission.decision').map((e) => [e.toolCallId, e.toolName, e.decision])).toEqual([
      ['call_code', 'run_code', 'allow'],
      ['call_code:1', 'get_price', 'allow'],
    ]);
  });

  it('inner calls act for the run\'s principal: the tool, needsApproval and permission rules see it', async () => {
    const seen: string[] = [];
    const whoami = defineTool({
      name: 'whoami',
      description: 'Who is calling',
      input: z.object({}),
      needsApproval: (_args, check) => {
        seen.push(`approval:${check.principal?.id}`);
        return false;
      },
      execute: async (_args, ctx) => ctx.principal?.id,
    });
    const model = scripted(`return await tools.whoami({});`);
    const rule = { ...allow('whoami'), when: (_args: unknown, call: { principal?: { id: string } }) => (seen.push(`rule:${call.principal?.id}`), true) };
    const result = await createAgent({ provider: model, tools: [whoami], codeMode: true, permissions: [rule] }).send('x', { principal: ALICE });
    expect(toolResult(result.messages).result).toBe('alice');
    expect(seen).toEqual(['rule:alice', 'approval:alice']);
  });

  it('a tool guardrail block on an inner call stops the run, as for a direct call', async () => {
    const sent = vi.fn();
    const email = defineTool({ name: 'send_email', description: 'Sends', input: z.object({ to: z.string() }), execute: sent });
    const guardrail: IoGuardrail = { name: 'no-evil', check: (ctx) => (ctx.text.includes('evil.com') ? { ok: false, reason: 'mentions evil.com' } : { ok: true }) };
    // The address is built in the script, so run_code's own arguments (the code) pass the guardrail.
    const model = scripted(`try { await tools.send_email({ to: 'x@' + 'evil' + '.com' }); } catch (e) { return 'caught'; } return 'sent';`);
    const result = await createAgent({ provider: model, tools: [email], codeMode: true, guardrails: { tools: [guardrail] } }).send('x');
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toMatchObject({ name: 'no-evil', kind: 'tool', toolName: 'send_email' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('a tool that needs a sign-in (ctx.getToken()) rejects inside the script; the run does not pause', async () => {
    const server = fakeOAuthServer();
    const { tool, executions } = listReposTool(githubProvider(server));
    const model = scripted(`try { return await tools.list_repos({}); } catch (e) { return e.message; }`);
    const agent = createAgent({ provider: model, tools: [tool], codeMode: true, store: memoryStore() });
    const result = await agent.send('x', { principal: ALICE });
    expect(result.finishReason).toBe('stop');
    expect(toolResult(result.messages).result).toBe('Tool list_repos needs the user to sign in to GitHub; call it directly, not from run_code.');
    expect(executions).toEqual([]);
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('a generator tool streams tool.partial events tagged with the parent; the script gets the last snapshot', async () => {
    const report = defineTool({
      name: 'report',
      description: 'Builds a report',
      input: z.object({}),
      async *execute() {
        yield { done: 1 };
        yield { done: 2 };
      },
    });
    const model = scripted(`return await tools.report({});`);
    const { events, result } = await collect(createAgent({ provider: model, tools: [report], codeMode: true }).stream('x'));
    expect(toolResult(result.messages).result).toEqual({ done: 2 });
    expect(ofType(events, 'tool.partial').map((e) => [e.toolCallId, e.parentToolCallId, e.index])).toEqual([
      ['call_code:1', 'call_code', 0],
      ['call_code:1', 'call_code', 1],
    ]);
  });

  it('Promise.all respects toolConcurrency', async () => {
    let running = 0;
    let peak = 0;
    const work = defineTool({
      name: 'work',
      description: 'Works',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running--;
        return n;
      },
    });
    const code = `return await Promise.all([1, 2, 3, 4].map((n) => tools.work({ n })));`;
    const serial = await createAgent({ provider: scripted(code), tools: [work], codeMode: true, toolConcurrency: 1 }).send('x');
    expect(toolResult(serial.messages).result).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(1);
    peak = 0;
    await createAgent({ provider: scripted(code), tools: [work], codeMode: true }).send('x');
    expect(peak).toBe(4);
  });

  it('inner calls get execute_tool spans under the run_code span', async () => {
    const ended: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };
    const { getPrice } = shopTools();
    await createAgent({ provider: scripted(`return await tools.get_price({ item: 'apple' });`), tools: [getPrice], codeMode: true, exporter }).send('x');
    const outer = ended.find((s) => s.name === 'execute_tool run_code');
    const inner = ended.find((s) => s.name === 'execute_tool get_price');
    expect(inner?.parentId).toBe(outer?.id);
    expect(inner?.attributes).toMatchObject({ 'gen_ai.tool.call.id': 'call_code:1', 'lousho.tool.parent_call_id': 'call_code' });
  });

  it('run_code itself can need approval: the script runs, through the gate, after the decision', async () => {
    const { getPrice, calls } = shopTools();
    const model = mockModel([{ toolCalls: [{ name: 'run_code', id: 'call_code', args: { code: `return await tools.get_price({ item: 'plum' });` } }] }, 'Done.']);
    const seen: string[] = [];
    const agent = createAgent({
      provider: model,
      tools: [getPrice],
      codeMode: true,
      permissions: [ask('run_code')],
      hooks: [{ name: 'spy', preToolCall: (ctx) => void seen.push(ctx.toolCallId) }],
    });
    const paused = await agent.send('x');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(calls).toEqual([]);
    const [pending] = await agent.approvals.list();
    const resumed = await agent.approvals.resolve({ id: pending.id, approved: true });
    expect(resumed.finishReason).toBe('stop');
    expect(toolResult(resumed.messages).result).toEqual({ item: 'plum', usd: 0.75 });
    expect(seen).toEqual(['call_code', 'call_code', 'call_code:1']);
  });
});

describe('code mode (N14): configuration', () => {
  it('rejects invalid options and a tool already named run_code', () => {
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { timeoutMs: 0 } })).toThrow(/'codeMode.timeoutMs' must be a whole number >= 1/);
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { tools: ['run_code'] } })).toThrow(/cannot name 'run_code'/);
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { nope: 1 } as never })).toThrow(/'codeMode.nope' is not an option/);
  });

  it('a tool named run_code fails the run', async () => {
    const own = defineTool({ name: 'run_code', description: 'mine', input: z.object({}), execute: async () => 1 }) as DefinedTool;
    await expect(createAgent({ provider: mockModel(['x']), tools: [own], codeMode: true }).send('x')).rejects.toThrow(/already registered, but code mode adds one/);
  });

  it('without codeMode there is no run_code tool', async () => {
    const { getPrice } = shopTools();
    const model = mockModel(['x']);
    await createAgent({ provider: model, tools: [getPrice] }).send('x');
    expect(names(model, 0)).toEqual(['get_price']);
  });
});

describe('code mode (N14): the isolate', () => {
  const limits = { timeoutMs: 2_000, memoryLimitBytes: 16 * 1024 * 1024, maxToolCalls: 5, maxOutputChars: 1_000 };
  const host = (overrides: Partial<ScriptHost> = {}): ScriptHost => ({
    toolNames: ['echo'],
    callTool: async (_name, args) => ({ json: JSON.stringify(args) }),
    ...overrides,
  });

  it('disposes every handle: the debug build reports no leak on any ending', async () => {
    const { newQuickJSWASMModule, DEBUG_SYNC } = await import('quickjs-emscripten');
    const debug = await newQuickJSWASMModule(DEBUG_SYNC);
    const run = (code: string, overrides?: Partial<ScriptHost>, extra?: Partial<typeof limits>) => runScript(debug, code, host(overrides), { ...limits, ...extra });
    await expect(run(`return await tools.echo({ a: 1 })`)).resolves.toMatchObject({ result: { a: 1 } });
    await expect(run(`throw new Error('boom')`)).rejects.toThrow(/boom/);
    await expect(run(`await tools.echo({}); for (;;) {}`, {}, { timeoutMs: 100 })).rejects.toThrow(/timeoutMs/);
    // (The debug build does not enforce the memory limit; the release build's is tested above.)
    await expect(run(`let s = 'x'; for (;;) s = s + s + '';`)).rejects.toThrow(/run_code failed: the script threw InternalError: string too long/);
    await expect(run(`for (let i = 0; i < 9; i++) await tools.echo({});`)).rejects.toThrow(/maxToolCalls/);
    await expect(run(`tools.echo({}); return 1;`, { callTool: () => new Promise((resolve) => setTimeout(() => resolve({ json: '1' }), 30)) })).resolves.toMatchObject({ result: 1 });
    await expect(run(`return await tools.echo({});`, { callTool: async () => ({ error: 'nope' }) })).rejects.toThrow(/ToolError: nope/);
    await expect(run(`await Promise.all([tools.echo({}), tools.echo({})]);`, { callTool: () => new Promise((resolve) => setTimeout(() => resolve({ json: '1' }), 500)) }, { timeoutMs: 100 })).rejects.toThrow(/timeoutMs/);
  });

  it('a host failure (a guardrail block) ends the script and is rethrown as is', async () => {
    const module = await loadQuickJS();
    const failure = new Error('blocked');
    await expect(runScript(module, `try { await tools.echo({}); } catch { return 'swallowed'; }`, host({ callTool: async () => { throw failure; } }), limits)).rejects.toBe(failure);
  });

  it('runs 200 short scripts without memory growth', async () => {
    const module = await loadQuickJS();
    const once = () => runScript(module, `let s = 0; for (let i = 0; i < 1000; i++) s += i; return { s, echoed: await tools.echo({ s }) };`, host(), limits);
    const batch = async () => {
      for (let i = 0; i < 200; i++) await expect(once()).resolves.toMatchObject({ result: { s: 499500 } });
    };
    // The first batch grows the WebAssembly heap to its working size (and, under coverage, V8's own counters).
    await batch();
    // The isolate's memory is the module's WebAssembly heap: a leak would grow it run after run.
    const heap = () => (module as unknown as { getWasmMemory?: () => WebAssembly.Memory }).getWasmMemory?.().buffer.byteLength ?? 0;
    const before = { heap: heap(), rss: process.memoryUsage().rss };
    await batch();
    expect(heap() - before.heap).toBe(0);
    expect(process.memoryUsage().rss - before.rss).toBeLessThan(64 * 1024 * 1024);
  });

  it('names the cause on the ScriptError', async () => {
    const module = await loadQuickJS();
    const error = await runScript(module, `for (;;) {}`, host(), { ...limits, timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).cause_).toBe('timeout');
  });
});
