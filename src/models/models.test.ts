import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../providers/llm';
import { estimateCost, estimateTokens, getModelInfo, registerModel, setTokenEstimator } from './index';

describe('estimateTokens', () => {
  afterEach(() => setTokenEstimator());

  it('is roughly chars/4 for English', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(text.length / 4 - 1);
    expect(tokens).toBeLessThanOrEqual(Math.ceil(text.length / 4));
  });

  it('is monotonic in length', () => {
    let previous = -1;
    for (const n of [0, 1, 10, 100, 1000]) {
      const tokens = estimateTokens('a'.repeat(n));
      expect(tokens).toBeGreaterThanOrEqual(previous);
      previous = tokens;
    }
    expect(estimateTokens('')).toBe(0);
  });

  it('counts CJK at a much higher ratio than English, by code point', () => {
    const cjk = '你好世界'.repeat(25); // 100 characters
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(80);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens('a'.repeat(100)) * 3);
    // astral CJK extension characters are 2 UTF-16 units but one code point
    expect(estimateTokens('\u{20000}'.repeat(10))).toBe(10);
  });

  it('counts other scripts between Latin and CJK', () => {
    const cyrillic = 'привет'.repeat(10);
    const tokens = estimateTokens(cyrillic);
    expect(tokens).toBeGreaterThan(estimateTokens('a'.repeat(60)));
    expect(tokens).toBeLessThan(estimateTokens('你'.repeat(60)));
  });

  it('counts emoji per code point and ignores joiners', () => {
    expect(estimateTokens('😀'.repeat(5))).toBe(10);
    expect(estimateTokens('👨‍👩')).toBe(estimateTokens('👨👩'));
  });

  it('adds per-message overhead and counts tool calls and results', () => {
    const user: Message = { role: 'user', content: 'Hi there' };
    const withCall: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"weather in Paris"}' } }],
    };
    const result: Message = { role: 'tool', toolCallId: 'call_1', toolName: 'search', content: '{"temp":21,"unit":"C"}' };

    expect(estimateTokens(user)).toBeGreaterThan(estimateTokens('Hi there'));
    expect(estimateTokens(withCall)).toBeGreaterThan(estimateTokens({ role: 'assistant', content: '' }));
    expect(estimateTokens([user, withCall, result])).toBe(
      estimateTokens(user) + estimateTokens(withCall) + estimateTokens(result)
    );
    expect(estimateTokens([user, user])).toBe(estimateTokens(user) * 2);
  });

  it('tolerates non-string content', () => {
    const odd = { role: 'user', content: { parts: ['a', 'b'] } } as unknown as Message;
    expect(estimateTokens(odd)).toBeGreaterThan(4);
    const missing = { role: 'user' } as unknown as Message;
    expect(estimateTokens(missing)).toBe(4);
  });

  it('supports a per-call and a global custom estimator', () => {
    const calls: Array<string | undefined> = [];
    const fixed = (_input: unknown, opts: { model?: string }) => {
      calls.push(opts.model);
      return 42;
    };
    expect(estimateTokens('anything', { estimator: fixed, model: 'gpt-4o' })).toBe(42);
    expect(calls).toEqual(['gpt-4o']);

    setTokenEstimator(() => 7);
    expect(estimateTokens('anything')).toBe(7);
    setTokenEstimator();
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('counts text parts as text and each image or file part as 1,000 tokens (LOU-V11)', () => {
    const parts: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'image', image: `data:image/png;base64,${'A'.repeat(40_000)}` },
        { type: 'file', data: new Uint8Array(10), mimeType: 'application/pdf' },
      ],
    };
    expect(estimateTokens(parts)).toBe(4 + 1 + 2_000);
    expect(estimateTokens({ role: 'user', content: [{ type: 'text', text: 'abcd' }] })).toBe(
      estimateTokens({ role: 'user', content: 'abcd' })
    );
  });
});

describe('model registry', () => {
  it('finds exact ids', () => {
    expect(getModelInfo('gpt-4o-mini')).toMatchObject({ provider: 'openai', contextWindow: 128000 });
    expect(getModelInfo('claude-sonnet-5-5')?.provider).toBe('anthropic');
  });

  it('resolves provider-prefixed ids', () => {
    expect(getModelInfo('openai/gpt-4o-mini')?.id).toBe('gpt-4o-mini');
    expect(getModelInfo('anthropic/claude-haiku-4-5')?.id).toBe('claude-haiku-4-5');
  });

  it('resolves dated snapshots and tags to the longest base id', () => {
    expect(getModelInfo('gpt-4o-mini-2024-07-18')?.id).toBe('gpt-4o-mini');
    expect(getModelInfo('gpt-4o-2024-08-06')?.id).toBe('gpt-4o');
    expect(getModelInfo('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
    expect(getModelInfo('ollama/llama3.1:8b')?.id).toBe('llama3.1');
  });

  it('does not match a different model that merely shares a prefix', () => {
    expect(getModelInfo('o3-mini')).toBeUndefined();
    expect(getModelInfo('gpt-5.4')).toBeUndefined();
    expect(getModelInfo('does-not-exist')).toBeUndefined();
  });

  it('lets later registrations add and override', () => {
    registerModel({ id: 'my-llama', provider: 'ollama', contextWindow: 8192 });
    expect(getModelInfo('my-llama')?.contextWindow).toBe(8192);
    expect(getModelInfo('my-llama-2025-01-01')?.id).toBe('my-llama');

    const original = getModelInfo('o4-mini')!;
    registerModel({ ...original, inputCostPerMTok: 1 });
    try {
      expect(getModelInfo('o4-mini')?.inputCostPerMTok).toBe(1);
    } finally {
      registerModel(original);
    }
    expect(getModelInfo('o4-mini')?.inputCostPerMTok).toBe(original.inputCostPerMTok);
  });
});

describe('estimateCost', () => {
  it('computes USD from per-million-token prices', () => {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gpt-4o')).toBeCloseTo(12.5);
    expect(estimateCost({ inputTokens: 2000, outputTokens: 500 }, 'openai/gpt-4o-mini')).toBeCloseTo(0.0006);
    expect(estimateCost({ inputTokens: 0, outputTokens: 0 }, 'gpt-4o')).toBe(0);
  });

  it('returns undefined, not 0, for unknown models or missing prices', () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, 'nope')).toBeUndefined();
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, 'llama3.1')).toBeUndefined();
  });
});
