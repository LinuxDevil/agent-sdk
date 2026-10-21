import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
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

    // Schemas no model can satisfy fail at definition, not on every call.
    it.each([
      ['zod 3 string root', z.string(), /'input' must be a z\.object\(\).*got string/],
      ['zod 3 array root', z.array(z.object({ a: z.string() })), /must be a z\.object\(\).*got array/],
      ['zod 4 string root', z4.string(), /must be a z\.object\(\).*got string/],
      ['zod 4 number root', z4.number().optional(), /must be a z\.object\(\)/],
    ])('rejects a non-object root (%s) with LOUSHO_CONFIG_INVALID', (_label, schema, message) => {
      expect(() => defineTool({ ...base, input: schema } as never)).toThrow(message);
      expect(() => defineTool({ ...base, input: schema } as never)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    });

    it.each([
      ['zod 3', z.object({ when: z.date(), n: z.bigint(), items: z.array(z.object({ due: z.date().optional() })) }), ["'items[].due'", "'n'", "'when'"]],
      ['zod 4', z4.object({ when: z4.date(), n: z4.bigint(), items: z4.array(z4.object({ due: z4.date().optional() })) }), ["'items[].due'", "'n'", "'when'"]],
    ])('rejects %s z.date() / z.bigint() fields and points to z.coerce', (_label, schema, paths) => {
      let error: unknown;
      try {
        defineTool({ ...base, input: schema } as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
      const message = (error as Error).message;
      for (const path of paths) expect(message).toContain(path);
      expect(message).toContain('z.coerce.date()');
      expect(message).toContain('z.coerce.bigint()');
    });

    // A misspelled safety key would otherwise run the tool without approval.
    it.each([
      ['requireApproval', 'needsApproval'],
      ['needApproval', 'needsApproval'],
      ['inputSchema', 'input'],
      ['parameters', 'input'],
      ['handler', 'execute'],
      ['deferLoad', 'deferLoading'],
    ])("rejects the unknown option '%s' and suggests '%s'", (key, suggestion) => {
      expect(() => defineTool({ ...base, [key]: true } as never)).toThrow(
        expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringContaining(`tool 'ok': '${key}' is not a known option (did you mean '${suggestion}'?)`) })
      );
    });

    it('rejects an unknown option with no plausible match, listing the allowed ones', () => {
      expect(() => defineTool({ ...base, frobnicate: 1 } as never)).toThrow(/'frobnicate' is not a known option\. Allowed options: name, description, input, /);
    });

    it('ignores an unknown option whose value is undefined', () => {
      expect(() => defineTool({ ...base, requireApproval: undefined } as never)).not.toThrow();
    });

    it('accepts a defined tool spread back in, but not a stray inputSchema', () => {
      const tool = defineTool(base);
      expect(defineTool({ ...tool, execute: () => 2 }).name).toBe('ok');
      expect(() => defineTool({ ...base, inputSchema: z.object({}) } as never)).toThrow(/'inputSchema' is not a known option \(did you mean 'input'\?\)/);
    });

    it('accepts z.coerce.date(), z.coerce.bigint(), refined objects and object unions', () => {
      expect(() => defineTool({ ...base, input: z.object({ when: z.coerce.date(), n: z.coerce.bigint() }) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z4.object({ when: z4.coerce.date(), n: z4.coerce.bigint() }) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z.object({ a: z.string() }).refine(() => true) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z4.object({ a: z4.string() }).refine(() => true) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z.object({ when: z.preprocess((v) => new Date(String(v)), z.date()) }) })).not.toThrow();
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
    // register() is overloaded; the cast narrows to the (name, descriptor) signature missing its second arg.
    expect(() => (registry.register as unknown as (n: string) => void)('x')).toThrow(/descriptor is required/);
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
    expect(agent.tools!.send_email).toEqual({ tool: 'send_email', description: 'Send an email' });
    expect(agent.tools!.legacy).toEqual({ tool: 'legacy' });
    // addTool() is overloaded; the cast narrows to the (key, config) signature missing its second arg.
    expect(() => (AgentBuilder.create().addTool as unknown as (k: string) => void)('x')).toThrow(
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

describe('defineTool timeoutMs', () => {
  const hang = (onAbort: (reason: unknown) => void) =>
    defineTool({
      name: 'hang',
      description: 'never finishes on its own',
      input: z.object({}),
      timeoutMs: 50,
      execute: (_args, { abortSignal }) =>
        new Promise<string>(() => {
          abortSignal?.addEventListener('abort', () => onAbort(abortSignal.reason));
        }),
    });

  it('a call still running after timeoutMs fails with a tool error the model sees, and its abortSignal is aborted', async () => {
    let aborted: unknown;
    const model = mockModel([{ toolCalls: [{ name: 'hang' }] }, 'gave up']);
    const result = await createAgent({ provider: model, tools: [hang((reason) => (aborted = reason))], instructions: 'x' }).send('go');

    expect(result.text).toBe('gave up');
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', isError: true, content: expect.stringContaining("timed out after 50 ms") });
    expect(aborted).toMatchObject({ code: 'LOUSHO_OPERATION_TIMEOUT' });
  });

  it('an aborted run stops waiting for a timed tool that ignores its signal', async () => {
    const slow = defineTool({ name: 'slow', description: 'ignores the signal', input: z.object({}), timeoutMs: 10_000, execute: () => new Promise(() => undefined) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow' }] }, 'never']), tools: [slow], instructions: 'x' }).send('go', {
      signal: controller.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects a timeoutMs that is not a positive number', () => {
    expect(() => defineTool({ name: 't', description: 'd', input: z.object({}), timeoutMs: 0, execute: () => 1 })).toThrow(/'timeoutMs' must be a positive/);
  });
});
