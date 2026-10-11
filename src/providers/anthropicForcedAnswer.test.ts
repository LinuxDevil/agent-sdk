/**
 * The forced answer at `maxSteps` (with `output`) through the real installed
 * `@ai-sdk/anthropic`: Anthropic rejects a request whose messages hold
 * `tool_use` / `tool_result` blocks without `tools`, so the tools must go
 * along on every `ai` major (some package majors drop them for `toolChoice: 'none'`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './AnthropicProvider';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';

const usage = { input_tokens: 10, output_tokens: 5 };
const message = (content: unknown[], stop_reason: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage,
});

describe('forced answer on Anthropic', () => {
  it('sends the tools with a transcript that has tool calls, so Claude accepts it', async () => {
    const bodies: Array<{ tools?: unknown[]; messages: Array<{ content: unknown }> }> = [];
    const fetch = async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      const hasToolBlocks = JSON.stringify(body.messages).includes('"tool_use"');
      if (hasToolBlocks && !body.tools?.length) {
        const error = { type: 'error', error: { type: 'invalid_request_error', message: 'Requests which include `tool_use` or `tool_result` blocks must define tools.' } };
        return new Response(JSON.stringify(error), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const reply = bodies.length === 1
        ? message([{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }], 'tool_use')
        : message([{ type: 'text', text: '{"answer":42}' }], 'end_turn');
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    };
    const lookup = defineTool({ name: 'lookup', description: 'Looks it up', input: z.object({}), execute: () => 42 });
    const provider = new AnthropicProvider({ apiKey: 'k', fetch, defaultModel: 'claude-haiku-4-5' });
    const result = await createAgent({ provider, tools: [lookup], output: z.object({ answer: z.number() }), maxSteps: 1, retry: false }).send('go');

    expect(result).toMatchObject({ finishReason: 'max-steps', object: { answer: 42 } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools?.length).toBe(1);
  });
});
