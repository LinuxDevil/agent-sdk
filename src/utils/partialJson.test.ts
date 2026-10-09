import { describe, expect, it } from 'vitest';
import { parsePartialJson } from './partialJson';

describe('parsePartialJson (Eve CORE-F13)', () => {
  it.each([
    ['', undefined],
    ['   ', undefined],
    ['{', {}],
    ['[', []],
    ['{"ti', {}],
    ['{"title"', {}],
    ['{"title":', {}],
    ['{"title": "Hel', { title: 'Hel' }],
    ['{"title": "Hello ', { title: 'Hello ' }],
    ['{"title": "Hello"', { title: 'Hello' }],
    ['{"title": "Hello",', { title: 'Hello' }],
    ['{"title": "Hello", "n": 4', { title: 'Hello', n: 4 }],
    ['{"title": "Hello", "n": 4.', { title: 'Hello' }],
    ['{"n": -', {}],
    ['{"ok": tr', {}],
    ['{"ok": true, "none": null', { ok: true, none: null }],
    ['{"tags": ["a", "b', { tags: ['a', 'b'] }],
    ['{"tags": ["a", ', { tags: ['a'] }],
    ['{"a": {"b": [1, {"c": "d', { a: { b: [1, { c: 'd' }] } }],
    ['{"a": {}, "b": []', { a: {}, b: [] }],
    ['{"q": "say \\"hi', { q: 'say "hi' }],
    ['{"q": "back\\\\', { q: 'back\\' }],
    ['{"q": "half \\', { q: 'half ' }],
    ['{"q": "snow \\u26', { q: 'snow ' }],
    ['{"q": "snow \\u2603', { q: 'snow ☃' }],
    ['"just a str', 'just a str'],
    ['{"done": 1}', { done: 1 }],
    ['```json\n{"title": "Hi', { title: 'Hi' }],
    ['```json\n{"title": "Hi"}\n```', { title: 'Hi' }],
  ])('%j -> %j', (text, expected) => {
    expect(parsePartialJson(text)).toEqual(expected);
  });

  it.each(['hello', '{"a" 1', '{"a": 1 "b"', '{"a":]', '{]', '{"a": nope}'])('%j is not JSON -> undefined', (text) => {
    expect(parsePartialJson(text)).toBeUndefined();
  });

  it('parses every prefix of a document without throwing, ending at the document', () => {
    const doc = JSON.stringify({ title: 'Ünïcode "quoted" \\ text', items: [{ id: 1, ok: false, tags: ['x', 'y'] }, { id: -2.5e3, none: null }], nested: { deep: [[], {}] } }, null, 2);
    let last: unknown;
    for (let end = 1; end <= doc.length; end++) last = parsePartialJson(doc.slice(0, end)) ?? last;
    expect(last).toEqual(JSON.parse(doc));
  });
});
