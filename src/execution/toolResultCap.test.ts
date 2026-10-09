/**
 * Eve TOOLS-F8: a tool result longer than `maxToolResultChars` (default 50_000)
 * reaches the model as its head and tail with a truncation marker.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { DEFAULT_MAX_TOOL_RESULT_CHARS, toolResultContent } from './toolResult';

const dump = (result: unknown, needsApproval = false) =>
  defineTool({ name: 'dump', description: 'Returns a lot', input: z.object({}), needsApproval, execute: async () => result });

const sentToolContent = (model: ReturnType<typeof mockModel>, call = 1): string => {
  const message = model.calls[call]?.messages.find((m) => m.role === 'tool');
  return message?.content as string;
};

describe('toolResultContent cap (Eve TOOLS-F8)', () => {
  it('leaves a result within the cap unchanged', () => {
    expect(toolResultContent('short', 10)).toBe('"short"');
    expect(toolResultContent({ a: 1 })).toBe('{"a":1}');
  });

  it('cuts a long string result to its head and tail with a marker, as a JSON string', () => {
    const text = `${'h'.repeat(600)}${'q'.repeat(1_000)}${'t'.repeat(400)}`;
    const content = toolResultContent(text, 1_000);
    const decoded = JSON.parse(content) as string;
    expect(decoded.startsWith('h'.repeat(600))).toBe(true);
    expect(decoded.endsWith('t'.repeat(400))).toBe(true);
    expect(decoded).not.toContain('q');
    expect(decoded).toContain('1000 characters truncated');
    expect(decoded).toContain('maxToolResultChars (1000)');
  });

  it('cuts a long object result as its JSON text, and stays valid JSON', () => {
    const content = toolResultContent({ rows: Array.from({ length: 5_000 }, (_, i) => ({ i })) }, 500);
    const decoded = JSON.parse(content) as string;
    expect(typeof decoded).toBe('string');
    expect(decoded.startsWith('{"rows":[{"i":0}')).toBe(true);
    expect(decoded).toContain('characters truncated');
  });

  it('Infinity turns the cap off', () => {
    const text = 'x'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS * 2);
    expect(toolResultContent(text, Infinity)).toBe(JSON.stringify(text));
  });
});

describe('createAgent({ maxToolResultChars }) (Eve TOOLS-F8)', () => {
  it('caps a 3 MB defineTool result at the default ~50k characters', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'dump', args: {} }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [dump('x'.repeat(3_000_000))] });
    const result = await agent.send('go');
    const content = sentToolContent(model);
    expect(content.length).toBeLessThan(DEFAULT_MAX_TOOL_RESULT_CHARS + 300);
    expect(content).toContain('2950000 characters truncated');
    // The transcript keeps the capped content too.
    expect((result.messages.find((m) => m.role === 'tool')?.content as string).length).toBe(content.length);
  });

  it('takes a smaller cap', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'dump', args: {} }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [dump('y'.repeat(10_000))], maxToolResultChars: 1_000 });
    await agent.send('go');
    expect(sentToolContent(model).length).toBeLessThan(1_300);
  });

  it('caps the result of a call run after approval', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'dump', args: {} }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [dump('z'.repeat(10_000), true)], maxToolResultChars: 1_000 });
    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(sentToolContent(model).length).toBeLessThan(1_300);
  });

  it('refuses a cap that is not a positive integer (LOUSHO_CONFIG_INVALID)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createAgent({ provider: mockModel(['x']), maxToolResultChars: bad })).toThrow(
        expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' })
      );
    }
  });
});
