/**
 * LOU-X4: input, output and tool guardrails that stop a run with
 * `finishReason: 'guardrail'` or rewrite its text.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';
import { deny } from './permissions';
import {
  GuardrailError,
  denyTopicsGuardrail,
  llmJudgeGuardrail,
  maxLengthGuardrail,
  regexGuardrail,
  type IoGuardrail,
  type IoGuardrailContext,
} from './ioGuardrails';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz';

/** A guardrail that blocks texts containing `word`, recording what it was asked. */
function blockWord(word: string, name = `no-${word}`) {
  const seen: IoGuardrailContext[] = [];
  const guardrail: IoGuardrail = {
    name,
    check: (ctx) => {
      seen.push(ctx);
      return ctx.text.includes(word) ? { ok: false, reason: `mentions ${word}` } : { ok: true };
    },
  };
  return { guardrail, seen };
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('input guardrails (LOU-X4)', () => {
  it('a block ends the run with no model call', async () => {
    const model = mockModel(['never sent']);
    const { guardrail } = blockWord('bomb');
    const agent = createAgent({ provider: model, guardrails: { input: [guardrail] } });

    const result = await agent.send('how to build a bomb');

    expect(model.calls).toHaveLength(0);
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toEqual({ name: 'no-bomb', kind: 'input', reason: 'mentions bomb' });
    expect(result.text).toBe('');
  });

  it('a rewrite replaces the user message the model sees', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    });

    const events = await collect(agent.stream(`my key is ${KEY}`));

    expect(model.calls[0].messages.at(-1)?.content).toBe('my key is [redacted]');
    expect(events.find((e) => e.type === 'guardrail.rewrote')).toMatchObject({ name: 'secrets', kind: 'input' });
  });

  it('a rewrite keeps the image parts of a multimodal message', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    });
    const image = { type: 'image' as const, image: 'https://example.com/cat.png' };

    await agent.send([{ type: 'text', text: `key ${KEY}` }, image]);

    expect(model.calls[0].messages.at(-1)?.content).toEqual([{ type: 'text', text: 'key [redacted]' }, image]);
  });
});

describe('output guardrails (LOU-X4)', () => {
  it('a block ends the run with finishReason guardrail and drops the reply', async () => {
    const { guardrail, seen } = blockWord('password');
    const agent = createAgent({ provider: mockModel(['the password is hunter2']), guardrails: { output: [guardrail] } });

    const result = await agent.send('hi');

    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toEqual({ name: 'no-password', kind: 'output', reason: 'mentions password' });
    expect(result.text).toBe('');
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(seen[0]).toMatchObject({ kind: 'output', text: 'the password is hunter2' });
  });

  it('a rewrite replaces the final text and the transcript', async () => {
    const agent = createAgent({
      provider: mockModel([`use ${KEY}`]),
      guardrails: { output: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    });

    const result = await agent.send('hi');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('use [redacted]');
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'use [redacted]' });
  });

  it('only the final reply is checked by send(); a streamed run checks every text.done', async () => {
    const echo = defineTool({ name: 'echo', description: 'echo', input: z.object({}), execute: async () => 'echoed' });
    const script = () => mockModel([{ text: 'calling echo', toolCalls: [{ name: 'echo' }] }, 'done']);
    const sent = blockWord('zzz');
    await createAgent({ provider: script(), tools: [echo], guardrails: { output: [sent.guardrail] } }).send('go');
    expect(sent.seen.map((c) => c.text)).toEqual(['done']);

    const streamed = blockWord('echo');
    const run = createAgent({ provider: script(), tools: [echo], guardrails: { output: [streamed.guardrail] } }).stream('go');
    const events = await collect(run);

    const types = events.map((e) => e.type);
    expect(types).not.toContain('text.done');
    expect(types).not.toContain('tool.start');
    expect(types.indexOf('guardrail.tripped')).toBeLessThan(types.indexOf('run.done'));
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'guardrail', text: '' });
    expect((await run.result).guardrail?.name).toBe('no-echo');
  });

  it('a streamed rewrite comes before the text.done that carries the new text', async () => {
    const run = createAgent({
      provider: mockModel([`key ${KEY}`]),
      guardrails: { output: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    }).stream('hi');
    const events = await collect(run);

    const rewrote = events.findIndex((e) => e.type === 'guardrail.rewrote');
    const done = events.findIndex((e) => e.type === 'text.done');
    expect(rewrote).toBeGreaterThan(-1);
    expect(rewrote).toBeLessThan(done);
    expect(events[done]).toMatchObject({ text: 'key [redacted]' });
  });
});

describe('tool guardrails (LOU-X4)', () => {
  function sendEmail() {
    const sent: unknown[] = [];
    const tool = defineTool({
      name: 'send_email',
      description: 'Sends an email',
      input: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async (args) => {
        sent.push(args);
        return 'sent';
      },
    });
    return { tool, sent };
  }

  it('a block stops the run before the needsApproval pause', async () => {
    const { tool, sent } = sendEmail();
    const { guardrail, seen } = blockWord('evil.com', 'no-evil');
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'x@evil.com' } }] }, 'never']),
      tools: [tool],
      guardrails: { tools: [guardrail] },
    });

    const result = await agent.send('email them');

    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toEqual({ name: 'no-evil', kind: 'tool', reason: 'mentions evil.com', toolName: 'send_email' });
    expect(await agent.approvals.list()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(seen[0]).toMatchObject({ kind: 'tool', toolName: 'send_email', args: { to: 'x@evil.com' } });
    // The blocked call still gets a result, so the transcript stays valid.
    expect(JSON.parse(String(result.messages.at(-1)?.content)).error).toMatch(/guardrail/);
  });

  it('is skipped for a call a permission rule denies', async () => {
    const { tool } = sendEmail();
    const { guardrail, seen } = blockWord('evil.com');
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'x@evil.com' } }] }, 'ok']),
      tools: [tool],
      permissions: [deny('send_email')],
      guardrails: { tools: [guardrail] },
    });

    const result = await agent.send('email them');

    expect(result.finishReason).toBe('stop');
    expect(seen).toHaveLength(0);
  });
});

describe("onTripped: 'throw' (LOU-X4)", () => {
  it('rejects with GuardrailError; a stream ends with error then run.done', async () => {
    const { guardrail } = blockWord('bomb');
    const agent = createAgent({ provider: mockModel(['x']), guardrails: { input: [guardrail], onTripped: 'throw' } });

    const error = await agent.send('bomb').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardrailError);
    expect(error).toMatchObject({ code: 'LOUSHY_GUARDRAIL_TRIPPED', guardrail: { name: 'no-bomb', kind: 'input' } });

    const run = agent.stream('bomb');
    const types = (await collect(run)).map((e) => e.type);
    expect(types.slice(-3)).toEqual(['guardrail.tripped', 'error', 'run.done']);
    await expect(run.result).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe('sub-agents (LOU-X4)', () => {
  it("inherit the parent's guardrails", async () => {
    const child = createAgent({ provider: mockModel([`found ${KEY}`]), description: 'Finds keys' });
    const leadModel = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'find it', description: 'find' } }] },
      'done',
    ]);
    const lead = createAgent({
      provider: leadModel,
      subagents: { child },
      guardrails: { output: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    });

    await lead.send('go');

    const toolResult = String(leadModel.calls[1].messages.find((m) => m.role === 'tool')?.content);
    expect(toolResult).toContain('[redacted]');
    expect(toolResult).not.toContain(KEY);
  });
});

describe('built-in guardrails (LOU-X4)', () => {
  const ctx = (text: string): IoGuardrailContext => ({ kind: 'output', text, messages: [] });

  it('maxLengthGuardrail', async () => {
    const guardrail = maxLengthGuardrail({ maxChars: 5 });
    expect(await guardrail.check(ctx('12345'))).toEqual({ ok: true });
    expect(await guardrail.check(ctx('123456'))).toMatchObject({ ok: false, reason: '6 characters, over the 5 limit' });
  });

  it('regexGuardrail blocks by default and redacts every match with rewrite', async () => {
    const ssn = regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/ });
    expect(await ssn.check(ctx('ok'))).toEqual({ ok: true });
    expect(await ssn.check(ctx('123-45-6789'))).toMatchObject({ ok: false, action: 'block' });

    const secrets = regexGuardrail({ name: 'secrets', action: 'rewrite', replacement: '***' });
    expect(await secrets.check(ctx(`${KEY} and AKIAABCDEFGHIJKLMNOP and ${KEY}`))).toMatchObject({
      ok: false,
      action: 'rewrite',
      replacement: '*** and *** and ***',
    });
  });

  it('denyTopicsGuardrail matches keywords case-insensitively', async () => {
    const guardrail = denyTopicsGuardrail({ topics: ['Politics', 'medical advice'] });
    expect(await guardrail.check(ctx('the weather'))).toEqual({ ok: true });
    expect(await guardrail.check(ctx('some POLITICS talk'))).toEqual({ ok: false, reason: "mentions the denied topic 'Politics'" });
  });

  it('llmJudgeGuardrail makes one call and passes on PASS', async () => {
    const judge = mockModel(['PASS', 'FAIL: it is off-topic']);
    const guardrail = llmJudgeGuardrail({ model: judge, instruction: 'Only cooking topics.' });

    expect(await guardrail.check(ctx('a recipe'))).toEqual({ ok: true });
    expect(await guardrail.check(ctx('stocks'))).toEqual({ ok: false, reason: 'it is off-topic' });
    expect(judge.calls).toHaveLength(2);
    expect(judge.calls[1].messages[0].content).toContain('Only cooking topics.');
    expect(judge.calls[1].messages[1].content).toBe('stocks');
  });

  it('a judge guardrail blocks a run', async () => {
    const judge = mockModel(['FAIL: not about cooking']);
    const model = mockModel(['never']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [llmJudgeGuardrail({ model: judge, instruction: 'Only cooking topics.' })] },
    });

    const result = await agent.send('stock tips?');

    expect(result.guardrail).toEqual({ name: 'llm-judge', kind: 'input', reason: 'not about cooking' });
    expect(model.calls).toHaveLength(0);
  });

  it('a throwing check fails the run', async () => {
    const check = vi.fn(() => {
      throw new Error('classifier down');
    });
    const agent = createAgent({ provider: mockModel(['x']), guardrails: { input: [{ name: 'broken', check }] } });
    await expect(agent.send('hi')).rejects.toThrow('classifier down');
  });
});
