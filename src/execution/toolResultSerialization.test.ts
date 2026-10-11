/**
 * A tool result JSON cannot encode as it is (a cycle, a BigInt, a Map or a
 * Set) reaches the model encoded as far as it can be, and never fails the run.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolResultContent } from './toolResult';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';

describe('toolResultContent with values JSON cannot encode', () => {
  it('a cycle becomes [Circular]; a shared, non-cyclic object is kept twice', () => {
    const shared = { x: 1 };
    const circular: Record<string, unknown> = { a: 1, shared, again: shared };
    circular.self = circular;
    expect(JSON.parse(toolResultContent(circular))).toEqual({ a: 1, shared: { x: 1 }, again: { x: 1 }, self: '[Circular]' });
  });

  it('a BigInt is its decimal string, a Map an object (or entry list), a Set an array', () => {
    expect(JSON.parse(toolResultContent({ n: 10n }))).toEqual({ n: '10' });
    expect(JSON.parse(toolResultContent({ m: new Map([['k', 1]]), s: new Set([1, 2]) }))).toEqual({ m: { k: 1 }, s: [1, 2] });
    expect(JSON.parse(toolResultContent(new Map([[1, 'one']])))).toEqual([[1, 'one']]);
  });

  it('a value that throws while encoding becomes an {error} the model reads', () => {
    const hostile = { toJSON: () => { throw new Error('nope'); } };
    expect(JSON.parse(toolResultContent(hostile))).toEqual({ error: 'The tool result could not be encoded as JSON: nope' });
  });
});

describe('a run whose tool returns such a value', () => {
  it.each([
    ['a cycle', () => { const value: Record<string, unknown> = { a: 1 }; value.self = value; return value; }, '{"a":1,"self":"[Circular]"}'],
    ['a BigInt', () => ({ n: 10n }), '{"n":"10"}'],
  ])('finishes, and the model sees the encoded result (%s)', async (_case, result, content) => {
    const tool = defineTool({ name: 'odd', description: 'returns an odd value', input: z.object({}), execute: result });
    const model = mockModel([{ toolCalls: [{ name: 'odd' }] }, 'done']);
    const run = await createAgent({ provider: model, tools: [tool], instructions: 'x' }).send('go');

    expect(run.text).toBe('done');
    const sent = model.calls[1].messages.at(-1);
    expect(sent).toMatchObject({ role: 'tool', content });
    expect(sent?.isError).toBeUndefined();
  });
});
