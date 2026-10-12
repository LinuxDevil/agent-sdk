import { createAgent, defineTool, currentDateTool, toolErrorResult, PropagatingToolError, createTodoTools } from '@lousho/build-ai-agent';
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const toolMsgs = (r: any) => r.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
const err = (f: () => unknown) => { try { f(); return 'no throw'; } catch (e: any) { return `${e.name} ${e.code ?? ''} ${String(e.message).slice(0, 120)}`; } };
console.log('name 64:', err(() => defineTool({ name: 'a'.repeat(64), description: 'd', input: z.object({}), execute: async () => 1 })));
console.log('name 65:', err(() => defineTool({ name: 'a'.repeat(65), description: 'd', input: z.object({}), execute: async () => 1 })));
console.log('empty desc:', err(() => defineTool({ name: 'x', description: '', input: z.object({}), execute: async () => 1 })));
console.log('non-zod input:', err(() => defineTool({ name: 'x', description: 'd', input: { type: 'object' } as any, execute: async () => 1 })));
const t = (name: string) => defineTool({ name, description: 'd', input: z.object({}), execute: async () => 1 });
console.log('dup in createAgent:', err(() => createAgent({ provider: mockModel(['x']), tools: [t('dup'), t('dup')] })));
const reg = new ToolRegistry(); reg.register(t('dup')); console.log('dup in registry:', err(() => reg.register(t('dup'))));
// errors
const ctxSeen: any[] = [];
const sendEmail = defineTool({ name: 'sendEmail', description: 'd', input: z.object({ to: z.string(), count: z.number() }), execute: async () => 'ok' });
const thrower = defineTool({ name: 'search', description: 'd', input: z.object({ q: z.string() }), execute: async () => { throw new TypeError('x'.repeat(2500)); } });
const kinded = defineTool({ name: 'kinded', description: 'd', input: z.object({}), execute: async () => { const e: any = new Error('custom'); e.toolErrorKind = 'denied'; throw e; } });
const undef = defineTool({ name: 'undef', description: 'd', input: z.object({}), execute: async (_a, ctx) => { ctxSeen.push(ctx); return undefined as any; } });
const m = mockModel([{ toolCalls: [{ name: 'sendEmail', args: { count: 'three' } }, { name: 'search', args: { q: 'a' } }, { name: 'nope', args: {} }, { name: 'kinded', args: {} }, { name: 'undef', args: {} }] }, 'done']);
const r = await createAgent({ instructions: 'SYS', provider: m, tools: [sendEmail, thrower, kinded, undef] }).send('hi', {});
for (const c of toolMsgs(r)) console.log(' tool result:', c.length > 300 ? c.slice(0, 120) + ' ... ' + c.slice(-60) + ` [len ${c.length}]` : c);
const ctx = ctxSeen[0]; console.log('ctx keys:', Object.keys(ctx).sort().join(','), '| messages roles:', ctx.messages.map((x: any) => x.role).join(','), '| toolCallId', ctx.toolCallId);
console.log('isError flags:', r.messages.filter((x: any) => x.role === 'tool').map((x: any) => x.isError ?? x.metadata?.isError));
// propagating
const prop = defineTool({ name: 'prop', description: 'd', input: z.object({}), execute: async () => { throw new PropagatingToolError('abort run'); } });
const e2: any = await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'prop', args: {} }] }, 'x']), tools: [prop] }).send('x').catch((e) => e);
console.log('propagating:', e2?.name, e2?.message);
console.log('toolErrorResult:', JSON.stringify(toolErrorResult({ toolName: 'x', error: new RangeError('bad'), kind: 'execution' } as any)));
// keyed built-ins
const m3 = mockModel([{ toolCalls: [{ name: 'current_date', args: {} }] }, 'x']);
const r3 = await createAgent({ provider: m3, tools: { current_date: currentDateTool } as any }).send('x');
console.log('keyed current_date:', toolMsgs(r3));
// order + concurrency
const order: string[] = [];
const sl = (name: string, ms: number) => defineTool({ name, description: 'd', input: z.object({}), execute: async () => { order.push('start ' + name); await new Promise((res) => setTimeout(res, ms)); order.push('end ' + name); return name; } });
const r4 = await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slowA', args: {} }, { name: 'fastB', args: {} }] }, 'x']), tools: [sl('slowA', 40), sl('fastB', 5)] }).send('x');
console.log('parallel order:', order.join(' > '), '| transcript order:', toolMsgs(r4));
order.length = 0;
await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slowA', args: {} }, { name: 'fastB', args: {} }] }, 'x']), tools: [sl('slowA', 40), sl('fastB', 5)], toolConcurrency: 1 } as any).send('x');
console.log('toolConcurrency 1:', order.join(' > '));
// todos
const todos = createTodoTools();
const m5 = mockModel([{ toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] } }] }, { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } }] }, 'ok']);
const evs: string[] = []; const run = createAgent({ provider: m5, tools: todos.tools }).stream('plan');
for await (const e of run) if (e.type.startsWith('todo')) evs.push(e.type + JSON.stringify((e as any).counts ?? ''));
console.log('todo results:', toolMsgs(await run.result).map((x: string) => x.slice(0, 160)));
console.log('todo events:', evs, 'getTodos:', JSON.stringify(await todos.getTodos()));
console.log('todo tool input schema keys:', JSON.stringify((todos.tools as any)[0]?.name ?? Object.keys(todos.tools)));
