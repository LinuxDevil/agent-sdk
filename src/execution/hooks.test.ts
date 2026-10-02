import { describe, it, expect, vi } from 'vitest';
import { HookRegistry, AgentHook } from './hooks';

function makeHook(name: string, overrides: Partial<AgentHook> = {}): AgentHook {
  return { name, ...overrides };
}

describe('HookRegistry', () => {
  it('registers, looks up, lists, and unregisters hooks', () => {
    const registry = new HookRegistry();
    const a = makeHook('a');
    const b = makeHook('b');

    registry.register(a);
    registry.register(b);

    expect(registry.size()).toBe(2);
    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')).toBe(a);
    expect(registry.list()).toEqual([a, b]);

    expect(registry.unregister('a')).toBe(true);
    expect(registry.has('a')).toBe(false);
    expect(registry.size()).toBe(1);

    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('registerMany registers hooks in the order given', () => {
    const registry = new HookRegistry();
    registry.registerMany([makeHook('a'), makeHook('b'), makeHook('c')]);
    expect(registry.list().map((h) => h.name)).toEqual(['a', 'b', 'c']);
  });

  it('overwrites a hook registered under an existing name and warns', () => {
    const registry = new HookRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeHook('dup');
    const second = makeHook('dup');

    registry.register(first);
    registry.register(second);

    expect(registry.size()).toBe(1);
    expect(registry.get('dup')).toBe(second);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clear() removes every hook', () => {
    const registry = new HookRegistry();
    registry.registerMany([makeHook('a'), makeHook('b')]);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('runs preToolCall hooks in registration order', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.register(makeHook('first', { preToolCall: async () => { order.push('first'); } }));
    registry.register(makeHook('second', { preToolCall: async () => { order.push('second'); } }));

    await registry.runPreToolCall({
      agentId: 'a1',
      messages: [],
      toolCallId: 'c1',
      toolName: 'foo',
      args: {},
      toolCall: { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
    });

    expect(order).toEqual(['first', 'second']);
  });

  it('a preToolCall hook can mutate ctx.args in place', async () => {
    const registry = new HookRegistry();
    registry.register(
      makeHook('redact-pii', {
        preToolCall: (ctx) => {
          ctx.args.email = '[REDACTED]';
        },
      })
    );

    const args: Record<string, unknown> = { email: 'real@example.com' };
    await registry.runPreToolCall({
      messages: [],
      toolCallId: 'c1',
      toolName: 'foo',
      args,
      toolCall: { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
    });

    expect(args.email).toBe('[REDACTED]');
  });

  it('aborts the sequence and propagates the error when a hook throws, skipping later hooks', async () => {
    const registry = new HookRegistry();
    const laterHook = vi.fn();
    registry.register(
      makeHook('rate-limit', {
        preToolCall: () => {
          throw new Error('rate limit exceeded');
        },
      })
    );
    registry.register(makeHook('later', { preToolCall: laterHook }));

    await expect(
      registry.runPreToolCall({
        messages: [],
        toolCallId: 'c1',
        toolName: 'foo',
        args: {},
        toolCall: { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
      })
    ).rejects.toThrow('rate limit exceeded');

    expect(laterHook).not.toHaveBeenCalled();
  });

  it('runs postToolCall hooks with the mutable result payload', async () => {
    const registry = new HookRegistry();
    registry.register(
      makeHook('audit-log', {
        postToolCall: (_ctx, result) => {
          result.result = { audited: true, original: result.result };
        },
      })
    );

    const result = { result: { raw: 1 } };
    await registry.runPostToolCall(
      {
        messages: [],
        toolCallId: 'c1',
        toolName: 'foo',
        args: {},
        toolCall: { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
      },
      result
    );

    expect(result.result).toEqual({ audited: true, original: { raw: 1 } });
  });

  it('runs preGenerate/postGenerate hooks and allows message injection', async () => {
    const registry = new HookRegistry();
    registry.register(
      makeHook('inject-context', {
        preGenerate: (ctx) => {
          ctx.request.messages.push({ role: 'system', content: 'injected' });
        },
      })
    );

    const request = { model: 'gpt-4', messages: [{ role: 'user' as const, content: 'hi' }] };
    await registry.runPreGenerate({ messages: request.messages, request });

    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]).toEqual({ role: 'system', content: 'injected' });

    const postSpy = vi.fn();
    registry.register(makeHook('observer', { postGenerate: postSpy }));
    const genResult = {
      text: 'hello',
      finishReason: 'stop' as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    await registry.runPostGenerate({ messages: request.messages, request }, genResult);
    expect(postSpy).toHaveBeenCalledWith({ messages: request.messages, request }, genResult);
  });

  it('no-ops safely when a hook implements only some methods', async () => {
    const registry = new HookRegistry();
    registry.register(makeHook('partial', { preToolCall: vi.fn() }));

    await expect(
      registry.runPostToolCall(
        {
          messages: [],
          toolCallId: 'c1',
          toolName: 'foo',
          args: {},
          toolCall: { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
        },
        { result: null }
      )
    ).resolves.toBeUndefined();

    await expect(
      registry.runPreGenerate({ messages: [], request: { model: 'x', messages: [] } })
    ).resolves.toBeUndefined();

    await expect(
      registry.runPostGenerate(
        { messages: [], request: { model: 'x', messages: [] } },
        { text: '', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
      )
    ).resolves.toBeUndefined();
  });
});
