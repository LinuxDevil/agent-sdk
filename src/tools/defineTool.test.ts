import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from './defineTool';
import { ToolRegistry } from './ToolRegistry';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import { mockModel } from '../testing';
import { AgentBuilder } from '../core/AgentBuilder';

const input = z.object({ to: z.string(), subject: z.string() });

function makeEmail(name = 'send_email') {
  return defineTool({
    name,
    description: 'Send an email',
    input,
    needsApproval: ({ to }) => !to.endsWith('@mycompany.com'),
    async execute({ to, subject }) {
      return { messageId: `${to}:${subject}` };
    },
  });
}

describe('defineTool', () => {
  it('builds a descriptor-compatible tool carrying its name', async () => {
    const t = makeEmail();
    expect(t.name).toBe('send_email');
    expect(t.displayName).toBe('send_email');
    expect(t.tool.description).toBe('Send an email');
    expect(await t.tool.execute!({ to: 'a@b.c', subject: 's' }, {} as never)).toEqual({
      messageId: 'a@b.c:s',
    });
    expect(await (t.needsApproval as (a: unknown) => unknown)({ to: 'x@other.com' })).toBe(true);
  });

  it('carries optional descriptor fields', () => {
    const t = defineTool({
      name: 'x',
      description: 'd',
      input,
      displayName: 'Nice',
      requiresSandbox: true,
      sandboxExecute: async ({ to }) => to,
      execute: () => 1,
    });
    expect(t.displayName).toBe('Nice');
    expect(t.requiresSandbox).toBe(true);
    expect(typeof t.sandboxExecute).toBe('function');
  });

  describe('validation', () => {
    const base = { name: 'ok', description: 'd', input, execute: () => 1 };
    it.each([
      [{ ...base, name: undefined }, /'name' is required/],
      [{ ...base, name: 'has space' }, /invalid tool name "has space".*"has_space"/],
      [{ ...base, name: 'a'.repeat(65) }, /invalid tool name/],
      [{ ...base, description: undefined }, /missing a 'description'/],
      [{ ...base, description: '  ' }, /missing a 'description'/],
      [{ ...base, input: { type: 'object' } }, /zod schema as 'input'/],
      [{ ...base, input: undefined }, /zod schema as 'input'/],
      [{ ...base, execute: undefined }, /'execute' function/],
    ])('rejects %#', (opts, message) => {
      expect(() => defineTool(opts as never)).toThrow(message);
    });
  });
});

describe('ToolRegistry.register(tool)', () => {
  it('registers under the tool name and keeps the (name, descriptor) form', () => {
    const registry = new ToolRegistry();
    const t = makeEmail();
    registry.register(t);
    registry.register('other', t);
    expect(registry.get('send_email')).toBe(t);
    expect(registry.has('other')).toBe(true);
  });

  it('throws a clear error naming both tools on a duplicate name', () => {
    const registry = new ToolRegistry();
    registry.register(makeEmail());
    const other = defineTool({
      name: 'send_email',
      description: 'd',
      input,
      displayName: 'Other',
      execute: () => 1,
    });
    expect(() => registry.register(other)).toThrow(
      /'send_email' is already registered.*"send_email".*"Other"/
    );
  });

  it('rejects non-defined tools and a missing descriptor', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ displayName: 'x', tool: {} } as never)).toThrow(/defineTool/);
    expect(() => (registry.register as (n: string) => void)('x')).toThrow(/descriptor is required/);
  });

  it('registerMany accepts an array of defined tools', () => {
    const registry = new ToolRegistry();
    registry.registerMany([makeEmail('a'), makeEmail('b')]);
    expect(registry.list()).toEqual(['a', 'b']);
  });
});

describe('entry points', () => {
  it('createAgent accepts an array of defined tools and runs them', async () => {
    const agent = createAgent({
      prompt: 'p',
      provider: createMockProvider({ responses: ['calling', 'done'] }),
      tools: [makeEmail('lookup')],
    });
    const result = await agent.send('please call lookup');
    expect(result.toolCalls.map((c) => c.function.name)).toEqual(['lookup']);
  });

  it('createAgent still accepts a record, including defined tools', () => {
    expect(() =>
      createAgent({
        prompt: 'p',
        provider: createMockProvider({ responses: ['x'] }),
        tools: { mine: makeEmail() },
      })
    ).not.toThrow();
  });

  it('createAgent rejects two tools with the same name', () => {
    expect(() =>
      createAgent({
        prompt: 'p',
        provider: createMockProvider({ responses: ['x'] }),
        tools: [makeEmail(), makeEmail()],
      })
    ).toThrow(/already registered/);
  });

  it('AgentBuilder.addTool(tool) keys the config by tool name', () => {
    const agent = AgentBuilder.create()
      .setName('a')
      .setPrompt('p')
      .addTool(makeEmail())
      .addTool('legacy', { tool: 'legacy' })
      .build();
    expect(agent.tools.send_email).toEqual({ tool: 'send_email', description: 'Send an email' });
    expect(agent.tools.legacy).toEqual({ tool: 'legacy' });
    expect(() => (AgentBuilder.create().addTool as (k: string) => void)('x')).toThrow(
      /configuration is required/
    );
  });

  it('delegation: a sub-agent can use defined tools', async () => {
    const sent: string[] = [];
    const childTool = defineTool({
      name: 'child_tool',
      description: 'Child tool',
      input: z.object({}),
      execute: () => {
        sent.push('ran');
        return 'child tool result';
      },
    });
    const child = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'child_tool' }] }, 'child answer']),
      tools: [childTool],
      description: 'Child agent',
    });
    const lead = createAgent({
      provider: mockModel([
        { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'please call child_tool', description: 'child task' } }] },
        'done',
      ]),
      subagents: { child },
    });
    const result = await lead.send('go');
    expect(sent).toEqual(['ran']);
    expect(result.text).toBe('done');
  });
});
