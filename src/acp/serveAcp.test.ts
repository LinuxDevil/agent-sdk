import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { serveAcp } from './serveAcp';

/** A parsed JSON value, read loosely in assertions. */
type Loose = { [key: string]: Loose };
type Msg = { id?: string | number | null; method?: string; params: Loose; result: Loose; error: Loose };

const lookup = defineTool({
  name: 'lookup',
  description: 'Look a topic up',
  input: z.object({ q: z.string() }),
  execute: ({ q }) => `found ${q}`,
});
const ping = defineTool({
  name: 'ping',
  description: 'Reply with pong',
  input: z.object({}),
  execute: () => 'pong',
  needsApproval: true,
});

/** An in-process ACP client: push lines, read what the server wrote, answer its requests. */
function client(turns: MockTurn[], config: Partial<CreateAgentConfig> = {}) {
  const model = mockModel(turns);
  const agent = createAgent({ instructions: 'You are a test agent.', provider: model, tools: [lookup, ping], ...config } as CreateAgentConfig);
  const out: Msg[] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const listeners: Array<() => void> = [];
  async function* input() {
    for (;;) {
      if (queue.length) yield queue.shift() as string;
      else if (ended) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const push = (line: string) => (queue.push(line), wake?.());
  const done = serveAcp(agent, {
    input: input(),
    write: (line) => {
      out.push(JSON.parse(line) as Msg);
      listeners.splice(0).forEach((fn) => fn());
    },
  });
  let nextId = 1;
  /** Waits until a written message matches. */
  const waitFor = (match: (m: Msg) => boolean): Promise<Msg> =>
    new Promise((resolve) => {
      const check = () => {
        const found = out.find(match);
        if (found) resolve(found);
        else listeners.push(check);
      };
      check();
    });
  const call = (method: string, params: unknown = {}) => {
    const id = nextId++;
    push(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return waitFor((m) => m.id === id && m.method === undefined);
  };
  const newSession = async () => (await call('session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId as unknown as string;
  const prompt = (sessionId: string, text: string) => call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const updates = (sessionId: string) => out.filter((m) => m.method === 'session/update' && m.params.sessionId === sessionId).map((m) => m.params.update);
  const end = async () => {
    ended = true;
    wake?.();
    await done;
  };
  return { model, out, push, call, newSession, prompt, updates, waitFor, end };
}

describe('serveAcp', () => {
  it('answers initialize with protocol version 1 and its capabilities', async () => {
    const c = client([]);
    const reply = await c.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(reply.result).toEqual({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    });
    await c.end();
  });

  it('streams agent_message_chunk updates, then ends the turn with end_turn', async () => {
    const c = client(['Hello there.']);
    const sessionId = await c.newSession();
    const reply = await c.prompt(sessionId, 'hi');
    expect(reply.result).toEqual({ stopReason: 'end_turn' });
    const chunks = c.updates(sessionId).filter((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(chunks.map((u) => u.content.text).join('')).toBe('Hello there.');
    expect(chunks[0].content.type).toBe('text');
    // Every update comes before the prompt's result.
    expect(c.out.indexOf(reply)).toBeGreaterThan(c.out.findIndex((m) => m.method === 'session/update'));
    await c.end();
  });

  it('reports a tool call as tool_call then tool_call_update', async () => {
    const c = client([{ toolCalls: [{ id: 'call-1', name: 'lookup', args: { q: 'cats' } }] }, 'Cats are great.']);
    const sessionId = await c.newSession();
    expect((await c.prompt(sessionId, 'look up cats')).result.stopReason).toBe('end_turn');
    const updates = c.updates(sessionId);
    const start = updates.find((u) => u.sessionUpdate === 'tool_call');
    expect(start).toMatchObject({ title: 'lookup', kind: 'other', status: 'in_progress', rawInput: { q: 'cats' } });
    expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: start?.toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'found cats' } }],
      rawOutput: 'found cats',
    });
    await c.end();
  });

  it('asks session/request_permission and streams the continuation when allowed', async () => {
    const c = client([{ toolCalls: [{ name: 'ping' }] }, 'The tool said pong.']);
    const sessionId = await c.newSession();
    const pending = c.prompt(sessionId, 'ping it');
    const ask = await c.waitFor((m) => m.method === 'session/request_permission');
    expect(ask.params).toMatchObject({
      sessionId,
      toolCall: { title: 'ping', rawInput: {} },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    c.push(JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
    expect((await pending).result.stopReason).toBe('end_turn');
    const updates = c.updates(sessionId);
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'pong' }));
    expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')).toBe('The tool said pong.');
    await c.end();
  });

  it('marks the tool call failed and never runs it when rejected', async () => {
    const c = client([{ toolCalls: [{ name: 'ping' }] }, 'Understood, not pinging.']);
    const sessionId = await c.newSession();
    const pending = c.prompt(sessionId, 'ping it');
    const ask = await c.waitFor((m) => m.method === 'session/request_permission');
    c.push(JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } }));
    expect((await pending).result.stopReason).toBe('end_turn');
    const updates = c.updates(sessionId);
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }));
    expect(updates).not.toContainEqual(expect.objectContaining({ rawOutput: 'pong' }));
    expect(JSON.stringify(c.model.calls[1].messages)).not.toContain('pong');
    expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')).toBe('Understood, not pinging.');
    await c.end();
  });

  it('session/cancel during a permission request ends the prompt with cancelled, and the session keeps working', async () => {
    const c = client([{ toolCalls: [{ name: 'ping' }] }, 'Next answer.']);
    const sessionId = await c.newSession();
    const pending = c.prompt(sessionId, 'ping it');
    await c.waitFor((m) => m.method === 'session/request_permission');
    c.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
    expect((await pending).result).toEqual({ stopReason: 'cancelled' });
    expect((await c.prompt(sessionId, 'something else')).result.stopReason).toBe('end_turn');
    await c.end();
  });

  it('session/cancel aborts a running turn before its next step', async () => {
    const c = client([{ toolCalls: [{ name: 'lookup', args: { q: 'a' } }], delayMs: 200 }, 'never']);
    const sessionId = await c.newSession();
    const pending = c.prompt(sessionId, 'hi');
    await new Promise((resolve) => setTimeout(resolve, 20));
    c.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
    expect((await pending).result).toEqual({ stopReason: 'cancelled' });
    expect(c.model.calls).toHaveLength(1);
    await c.end();
  });

  it('keeps one history across the prompts of a session', async () => {
    const c = client(['Hi Ali.', 'You are Ali.']);
    const sessionId = await c.newSession();
    await c.prompt(sessionId, 'I am Ali.');
    await c.prompt(sessionId, 'Who am I?');
    const contents = c.model.calls[1].messages.map((m) => String(m.content));
    expect(contents).toContain('I am Ali.');
    expect(contents).toContain('Hi Ali.');
    await c.end();
  });

  it('ends the turn on an ask_question with the question as the message, and the next prompt answers it', async () => {
    const c = client(
      [{ toolCalls: [{ name: 'ask_question', args: { question: 'Where to?', options: ['Porto', 'Lisbon'] } }] }, 'Lisbon it is.'],
      { askQuestion: true }
    );
    const sessionId = await c.newSession();
    expect((await c.prompt(sessionId, 'plan a trip')).result.stopReason).toBe('end_turn');
    expect(c.updates(sessionId)).toContainEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Where to?\n1. Porto\n2. Lisbon' } });
    expect((await c.prompt(sessionId, 'Lisbon')).result.stopReason).toBe('end_turn');
    expect(JSON.stringify(c.model.calls[1].messages)).toContain('Lisbon');
    await c.end();
  });

  it('answers -32601 for an unknown method, -32700 for bad JSON and -32602 for an unknown session', async () => {
    const c = client([]);
    expect((await c.call('session/load', {})).error).toMatchObject({ code: -32601 });
    c.push('{not json');
    expect((await c.waitFor((m) => m.id === null)).error).toMatchObject({ code: -32700 });
    expect((await c.prompt('nope', 'hi')).error).toMatchObject({ code: -32602 });
    c.push(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification', params: {} }));
    await c.end();
  });

  it('turns a failed run into a JSON-RPC error carrying the SDK error code', async () => {
    const c = client([{ error: new Error('boom') }]);
    const sessionId = await c.newSession();
    const reply = await c.prompt(sessionId, 'hi');
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain('boom');
    expect(reply.error.data.code).toMatch(/^LOUSHY_/);
    await c.end();
  });

  it.each([
    ['max-steps', { maxSteps: 1 }, [{ toolCalls: [{ name: 'lookup', args: { q: 'a' } }] }, 'never'], 'max_turn_requests'],
    ['budget-exceeded', { limits: { maxOutputTokens: 1 } }, [{ toolCalls: [{ name: 'lookup', args: { q: 'a' } }], usage: { inputTokens: 1, outputTokens: 50 } }, 'never'], 'max_tokens'],
    ['length', {}, [{ text: 'cut', finishReason: 'length' }], 'max_tokens'],
    [
      'guardrail',
      { guardrails: { input: [{ name: 'block', check: () => ({ ok: false, reason: 'no' }) }] } },
      ['never'],
      'refusal',
    ],
  ] as Array<[string, Partial<CreateAgentConfig>, MockTurn[], string]>)('maps finish reason %s to %s', async (_reason, config, turns, stop) => {
    const c = client(turns, config);
    const sessionId = await c.newSession();
    expect((await c.prompt(sessionId, 'go')).result).toEqual({ stopReason: stop });
    await c.end();
  });
});
