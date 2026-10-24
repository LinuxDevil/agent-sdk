import { describe, expect, it } from 'vitest';

import { detectVariables } from '../variables';
import { createSseParser } from '../sse';
import { messagesFromObservation, modelFromObservation, parsePromptParam } from '../prefill';
import { buildRunBody, defaultProvider, modelString, providerOptions } from '../request';
import { STARTED_RUN, applyRunEvent } from '../runState';
import type { ObserveObservationRow } from '../../../observe/types';

function gen(over: Partial<ObserveObservationRow>): ObserveObservationRow {
  return {
    obs_id: 'g1', trace_id: 't1', session_id: null, agent_id: null, parent_obs_id: null, kind: 'generation',
    name: 'llm', start: 0, end: 1, status: 'ok', input: null, output: null, model: null,
    usage_input_tokens: null, usage_output_tokens: null, usage_cached_tokens: null, usage_reasoning_tokens: null,
    cost_usd: null, cost_partial: null, usage_estimated: null, truncated: false, attrs: null, ...over,
  };
}

describe('detectVariables', () => {
  it('finds {names} across rows, de-duplicated in first-seen order', () => {
    expect(
      detectVariables([
        { role: 'system', content: 'You are {persona}. Speak {lang}.' },
        { role: 'user', content: 'Hi {name}, in {lang} please; {user.id} {a-b}' },
      ]),
    ).toEqual(['persona', 'lang', 'name', 'user.id', 'a-b']);
  });

  it('ignores braces that are not identifiers (JSON, numbers, empty)', () => {
    expect(detectVariables([{ role: 'user', content: '{"a": 1} {1x} {} { spaced }' }])).toEqual([]);
  });
});

describe('createSseParser', () => {
  it('parses data frames split across chunks and skips junk', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"delta","text":"He"}\n\ndata: {"type":"del')).toEqual([{ type: 'delta', text: 'He' }]);
    expect(parser.push('ta","text":"llo"}\r\n\r\n: comment\n\ndata: not json\n\n')).toEqual([{ type: 'delta', text: 'llo' }]);
    expect(parser.push('data: {"type":"done","finishReason":"stop","text":"Hello"}\n\n')).toEqual([
      { type: 'done', finishReason: 'stop', text: 'Hello' },
    ]);
  });

  it('flushes a final frame without a trailing blank line', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"error","message":"x"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: 'error', message: 'x' }]);
  });
});

describe('messagesFromObservation', () => {
  it('reads an OpenAI-style message array', () => {
    const row = gen({ input: JSON.stringify([{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'Hi' }, { role: 'tool', content: 'x' }]) });
    expect(messagesFromObservation(row)).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('reads {messages} and gen_ai parts, prepending system instructions from attrs', () => {
    const row = gen({
      input: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', content: 'Weather?' }] }] }),
      attrs: { 'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'You are terse.' }]) },
    });
    expect(messagesFromObservation(row)).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Weather?' },
    ]);
  });

  it('turns a plain string (or truncated JSON) into one user message', () => {
    expect(messagesFromObservation(gen({ input: 'hello there' }))).toEqual([{ role: 'user', content: 'hello there' }]);
    expect(messagesFromObservation(gen({ input: '[{"role":"us' }))).toEqual([{ role: 'user', content: '[{"role":"us' }]);
    expect(messagesFromObservation(gen({ input: null }))).toEqual([]);
  });
});

describe('modelFromObservation', () => {
  it('prefixes the provider when attrs name it, else the bare model', () => {
    expect(modelFromObservation(gen({ model: 'gpt-4o-mini', attrs: { 'gen_ai.provider.name': 'openai' } }))).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(modelFromObservation(gen({ model: 'claude-x' }))).toEqual({ provider: '', model: 'claude-x' });
    expect(modelFromObservation(gen({ model: 'ollama/llama3.2' }))).toEqual({ provider: 'ollama', model: 'llama3.2' });
    expect(modelFromObservation(gen({}))).toBeUndefined();
  });
});

describe('parsePromptParam', () => {
  it('splits name@ref, defaulting to latest', () => {
    expect(parsePromptParam('greeter')).toEqual({ name: 'greeter', ref: 'latest' });
    expect(parsePromptParam('greeter@prod')).toEqual({ name: 'greeter', ref: 'prod' });
    expect(parsePromptParam('greeter@3')).toEqual({ name: 'greeter', ref: '3' });
    expect(parsePromptParam('')).toBeUndefined();
  });
});

describe('request helpers', () => {
  const keys = [
    { provider: 'openai' as const, hasKey: false, masked: null },
    { provider: 'anthropic' as const, hasKey: true, masked: 'x' },
  ];

  it('offers keyed providers plus ollama and mock, defaulting to mock with no keys', () => {
    expect(providerOptions(keys)).toEqual(['anthropic', 'ollama', 'mock']);
    expect(defaultProvider(keys)).toBe('anthropic');
    expect(defaultProvider([])).toBe('mock');
  });

  it('builds the model string', () => {
    expect(modelString('mock', 'ignored')).toBe('mock');
    expect(modelString('openai', ' gpt-4o-mini ')).toBe('openai/gpt-4o-mini');
    expect(modelString('ollama', '')).toBe('ollama');
    expect(modelString('', 'claude-x')).toBe('claude-x');
  });

  it('drops empty rows, sends only detected variables, and omits empty optionals', () => {
    expect(buildRunBody({ messages: [{ role: 'system', content: ' ' }], values: {}, model: 'mock', tools: [] })).toBeUndefined();
    expect(
      buildRunBody({
        messages: [{ role: 'system', content: '' }, { role: 'user', content: 'Hi {name}' }],
        values: { name: 'Ada', stale: 'x' },
        model: 'mock',
        tools: ['current-date'],
        promptRef: 'greeter@prod',
      }),
    ).toEqual({
      messages: [{ role: 'user', content: 'Hi {name}' }],
      variables: { name: 'Ada' },
      model: 'mock',
      tools: ['current-date'],
      promptRef: 'greeter@prod',
    });
  });
});

describe('applyRunEvent', () => {
  it('accumulates deltas and tool calls, ends on done or error, then ignores events', () => {
    let s = applyRunEvent(STARTED_RUN, { type: 'delta', text: 'a' });
    s = applyRunEvent(s, { type: 'tool_call', id: 'c1', name: 'current-date', args: {} });
    s = applyRunEvent(s, { type: 'delta', text: 'b' });
    expect(s).toMatchObject({ status: 'running', text: 'ab', toolCalls: [{ id: 'c1' }] });
    const done = applyRunEvent(s, { type: 'done', finishReason: 'awaiting-approval', text: '', traceId: 't' });
    expect(done).toMatchObject({ status: 'paused', text: 'ab', traceId: 't' });
    expect(applyRunEvent(done, { type: 'delta', text: 'x' })).toBe(done);
    expect(applyRunEvent(STARTED_RUN, { type: 'error', message: 'boom', code: 'C' })).toMatchObject({ status: 'error', error: 'boom (C)' });
  });
});
