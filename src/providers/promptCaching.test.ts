/**
 * Eve PROV-F4: Anthropic prompt-cache breakpoints, as the AI SDK's
 * `providerOptions` (AnthropicProvider) and as an OpenRouter body rewrite.
 */

import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from './OpenRouterProvider';
import { cachesPrompt, isAnthropicModel, withBodyBreakpoints, withMessageBreakpoints } from './promptCaching';
import type { GenerateOptions, ToolDefinition } from './llm';
import { createAgent } from '../createAgent';

const ephemeral = { type: 'ephemeral' };
const tool = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

describe('which models get breakpoints', () => {
  it('Claude models, directly or through OpenRouter, unless promptCaching is false', () => {
    expect(isAnthropicModel('claude-haiku-4-5')).toBe(true);
    expect(isAnthropicModel('anthropic/claude-haiku-4.5')).toBe(true);
    expect(isAnthropicModel('openai/gpt-4o-mini')).toBe(false);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', undefined)).toBe(true);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', 'auto')).toBe(true);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', false)).toBe(false);
    expect(cachesPrompt('gpt-4o-mini', 'auto')).toBe(false);
  });
});

describe('withMessageBreakpoints (AI SDK providerOptions)', () => {
  it('marks the last system message and a trailing user or tool turn', () => {
    const marked = withMessageBreakpoints([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [] },
      { role: 'tool', content: [] },
    ]);
    const cache = { anthropic: { cacheControl: ephemeral } };
    expect(marked.map((message) => (message as { providerOptions?: unknown }).providerOptions)).toEqual([undefined, cache, undefined, undefined, cache]);
  });

  it('leaves a trailing assistant turn alone', () => {
    const marked = withMessageBreakpoints([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
    expect(marked.some((message) => 'providerOptions' in message)).toBe(false);
  });
});

describe('withBodyBreakpoints (OpenRouter body)', () => {
  it('marks the system prompt, the last function tool and the last user turn', () => {
    const body = withBodyBreakpoints({
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
      ],
      tools: [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'b' } },
        { type: 'openrouter:web_search' },
      ],
    });
    expect(body.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'rules', cache_control: ephemeral }] },
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: ephemeral }, { type: 'image_url', image_url: { url: 'x' } }] },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' }, cache_control: ephemeral },
      { type: 'openrouter:web_search' },
    ]);
  });

  it('marks no empty text, and no trailing tool or assistant turn', () => {
    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: 'r', tool_call_id: '1' },
    ];
    expect(withBodyBreakpoints({ messages }).messages).toEqual(messages);
  });
});

/** An OpenRouterProvider whose requests are captured instead of sent. */
function capturingOpenRouter() {
  const bodies: Array<Record<string, unknown>> = [];
  const reply = {
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };
  const provider = new OpenRouterProvider({
    apiKey: 'k',
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  });
  return { provider, bodies };
}

const call = (model: string, extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  model,
  messages: [
    { role: 'system', content: 'You are a support bot.' },
    { role: 'user', content: 'Say ok.' },
  ],
  tools: [tool('lookup'), tool('refund')],
  ...extra,
});

describe('OpenRouterProvider sends cache_control (Eve PROV-F4)', () => {
  it('on an Anthropic model by default', async () => {
    const { provider, bodies } = capturingOpenRouter();
    await provider.generate(call('anthropic/claude-haiku-4.5'));
    const [body] = bodies;
    const messages = body.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([{ type: 'text', text: 'You are a support bot.', cache_control: ephemeral }]);
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Say ok.', cache_control: ephemeral }]);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual(ephemeral);
  });

  it('not with promptCaching: false, and not on other models', async () => {
    const { provider, bodies } = capturingOpenRouter();
    await provider.generate(call('anthropic/claude-haiku-4.5', { promptCaching: false }));
    await provider.generate(call('openai/gpt-4o-mini'));
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('createAgent({ promptCaching: false }) reaches the provider', async () => {
    const { provider, bodies } = capturingOpenRouter();
    await createAgent({ provider, model: 'anthropic/claude-haiku-4.5', instructions: 'Be brief.', retry: false }).send('hi');
    await createAgent({ provider, model: 'anthropic/claude-haiku-4.5', instructions: 'Be brief.', retry: false, promptCaching: false }).send('hi');
    expect(JSON.stringify(bodies[0])).toContain('cache_control');
    expect(JSON.stringify(bodies[1])).not.toContain('cache_control');
  });
});
