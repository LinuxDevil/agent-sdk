/**
 * LOU-W4: sessions (multi-turn conversations) for createAgent().
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { mockModel, type MockRequest } from '../testing';
import { FileSessionStore, MemorySessionStore, type SessionStore } from './index';
import { AgentSession, providerValidPrefix } from './AgentSession';
import type { Message, ToolCall } from '../providers/llm';

const convo = (call: Pick<MockRequest, 'messages'> | undefined): MockRequest['messages'] =>
  (call?.messages ?? []).filter((m) => m.role !== 'system');
const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);

describe('AgentSession', () => {
  it('shows the second turn the first exchange', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'Your name is Ali.']);
    const session = createAgent({ prompt: 'Be brief.', provider: model }).session();

    await session.send('My name is Ali.');
    const second = await session.send('What is my name?');

    expect(second.text).toBe('Your name is Ali.');
    expect(model.calls[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:Be brief.',
      'user:My name is Ali.',
      'assistant:Nice to meet you, Ali.',
      'user:What is my name?',
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('exposes a snapshot that cannot corrupt the session', async () => {
    const session = createAgent({ provider: mockModel(['a', 'b']) }).session();
    await session.send('1');
    // Deliberately defeat the readonly type: the test is that the runtime snapshot still cannot corrupt the session.
    (session.messages as unknown as { content: string }[])[0].content = 'tampered';
    expect(session.messages[0].content).toBe('1');
  });

  it('keeps tool-call turns in a provider-valid order', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'look up',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => `result for ${q}`,
    });
    const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 'x' } }] }, 'It is x.', 'Still x.']);
    const session = createAgent({ provider: model, tools: [lookup] }).session();

    await session.send('find x');
    expect(roles(session.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    await session.send('again?');

    const sent = convo(model.calls[2]);
    expect(roles(sent)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(sent[1].toolCalls?.[0].id).toBe(sent[2].toolCallId);
  });

  it('serializes concurrent sends so the transcript cannot interleave', async () => {
    const model = mockModel([
      { text: 'r1', delayMs: 30 },
      { text: 'r2', delayMs: 1 },
      { text: 'r3', delayMs: 1 },
    ]);
    const session = createAgent({ provider: model }).session();

    const results = await Promise.all([session.send('a'), session.send('b'), session.send('c')]);

    expect(results.map((r) => r.text)).toEqual(['r1', 'r2', 'r3']);
    expect(session.messages.map((m) => m.content)).toEqual(['a', 'r1', 'b', 'r2', 'c', 'r3']);
    expect(convo(model.calls[2]).map((m) => m.content)).toEqual(['a', 'r1', 'b', 'r2', 'c']);
  });

  it('serializes concurrent sends across session OBJECTS that share one transcript store', async () => {
    // support-desk F3: two `agent.session({ id })` objects (e.g. two concurrent
    // HTTP requests on one session) each kept their own queue, so both turns
    // ran at once and the last commit silently overwrote the other.
    const store = new MemorySessionStore();
    const model = mockModel([
      { text: 'r1', delayMs: 30 },
      { text: 'r2', delayMs: 1 },
    ]);
    const agent = createAgent({ provider: model });
    const a = agent.session({ id: 'shared', store });
    const b = agent.session({ id: 'shared', store });

    const [ra, rb] = await Promise.all([a.send('first'), b.send('second')]);

    expect(ra.text).toBe('r1');
    expect(rb.text).toBe('r2');
    // Both turns are committed: the second turn saw the first's exchange.
    expect((await store.load('shared'))!.map((m) => m.content)).toEqual(['first', 'r1', 'second', 'r2']);
    expect(convo(model.calls[1]).map((m) => m.content)).toEqual(['first', 'r1', 'second']);
  });

  it('a turn losing the race against a writer the queue cannot see fails with LOUSHO_SESSION_BUSY', async () => {
    // Two different store objects over the same transcript cannot share the
    // in-process queue (two processes, or fileStore(dir) built twice), so the
    // commit guards on the transcript instead: the loser rejects loudly
    // instead of silently dropping a turn.
    const inner = new MemorySessionStore();
    const wrap = (): SessionStore => ({
      load: (id) => inner.load(id),
      save: (id, messages) => inner.save(id, messages),
      delete: (id) => inner.delete(id),
    });
    const model = mockModel([
      { text: 'slow answer', delayMs: 50 },
      { text: 'fast answer', delayMs: 1 },
    ]);
    const agent = createAgent({ provider: model });
    const slow = agent.session({ id: 'shared', store: wrap() });
    const fast = agent.session({ id: 'shared', store: wrap() });

    const [ra, rb] = await Promise.allSettled([slow.send('first'), fast.send('second')]);

    expect(rb).toMatchObject({ status: 'fulfilled', value: { text: 'fast answer' } });
    expect(ra.status).toBe('rejected');
    expect((ra as PromiseRejectedResult).reason).toMatchObject({ name: 'SDKError', code: 'LOUSHO_SESSION_BUSY' });
    // The winner's turn is intact; the loser's message was not half-written.
    expect((await inner.load('shared'))!.map((m) => m.content)).toEqual(['second', 'fast answer']);
  });

  it('keeps the queue alive after a failed send', async () => {
    const model = mockModel([{ error: new Error('boom') }, 'fine']);
    const session = createAgent({ provider: model }).session();
    const failed = session.send('one');
    const ok = session.send('two');
    await expect(failed).rejects.toThrow('boom');
    expect((await ok).text).toBe('fine');
    expect(session.messages.map((m) => m.content)).toEqual(['two', 'fine']);
  });

  it('leaves the transcript unchanged when a tool throws a propagating error', async () => {
    const fatal = defineTool({
      name: 'fatal',
      description: 'always fails hard',
      input: z.object({}),
      execute: async () => {
        throw new PropagatingToolError('stop everything');
      },
    });
    const model = mockModel(['hello', { toolCalls: [{ name: 'fatal' }] }, 'recovered']);
    const session = createAgent({ provider: model, tools: [fatal] }).session();

    await session.send('hi');
    const before = session.messages;
    await expect(session.send('do the fatal thing')).rejects.toThrow('stop everything');
    expect(session.messages).toEqual(before);

    await session.send('are you ok?');
    expect(roles(convo(model.calls[2]))).toEqual(['user', 'assistant', 'user']);
  });

  it('leaves the transcript unchanged when a send is aborted', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        controller.abort();
        return 'done';
      },
    });
    const model = mockModel(['hello', { toolCalls: [{ name: 'slow' }, { name: 'slow' }] }, 'next']);
    const session = createAgent({ provider: model, tools: [slow] }).session();
    await session.send('hi');
    const before = session.messages;

    const aborted = await session.send('go', { signal: controller.signal });

    expect(aborted.finishReason).toBe('aborted');
    expect(session.messages).toEqual(before);
    await session.send('still there?');
    expect(roles(convo(model.calls[2]))).toEqual(['user', 'assistant', 'user']);
  });

  it('clear() forgets the conversation, including in the store', async () => {
    const store = new MemorySessionStore();
    const model = mockModel(['a', 'b']);
    const session = createAgent({ provider: model }).session({ id: 'c1', store });
    await session.send('1');
    await session.clear();

    expect(session.messages).toEqual([]);
    expect(await store.load('c1')).toBeUndefined();
    await session.send('2');
    expect(convo(model.calls[1]).map((m) => m.content)).toEqual(['2']);
  });

  it('rejects invalid ids', () => {
    const agent = createAgent({ provider: mockModel([]) });
    for (const id of ['../evil', 'a/b', 'a.b', '', 'x'.repeat(129)]) {
      expect(() => agent.session({ id })).toThrow(/Invalid session id/);
      expect(() => agent.session({ id })).toThrow(expect.objectContaining({ code: 'LOUSHO_SESSION_ID_INVALID' }));
    }
    expect(() => agent.session({ id: 'user_42-A' })).not.toThrow();
  });

  describe('FileSessionStore', () => {
    it('round-trips a conversation across two createAgent instances', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
      try {
        const first = createAgent({ provider: mockModel(['Hi Ali.']) });
        const s1 = first.session({ id: 'ali', store: new FileSessionStore(dir) });
        await s1.send('My name is Ali.');

        const model = mockModel(['Ali.']);
        const s2 = createAgent({ provider: model }).session({ id: 'ali', store: new FileSessionStore(dir) });
        expect(await s2.load()).toHaveLength(2);
        await s2.send('What is my name?');

        expect(convo(model.calls[0]).map((m) => m.content)).toEqual([
          'My name is Ali.',
          'Hi Ali.',
          'What is my name?',
        ]);
        expect(readdirSync(dir)).toEqual(['ali.json']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses path traversal ids and treats missing sessions as empty', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
      try {
        const store = new FileSessionStore(join(dir, 'nested'));
        await expect(store.load('../x')).rejects.toThrow(/Invalid session id/);
        await expect(store.save('a/b', [])).rejects.toThrow(/Invalid session id/);
        await expect(store.delete('..')).rejects.toThrow(/Invalid session id/);
        expect(await store.load('missing')).toBeUndefined();
        await store.delete('missing');
        await store.save('ok', [{ role: 'user', content: 'x' }]);
        await store.delete('ok');
        expect(await store.load('ok')).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('round-trips image and file bytes through JSON as base64 (LOU-V11)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
      try {
        const store = new FileSessionStore(dir);
        const messages: Message[] = [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              { type: 'image', image: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' },
              { type: 'image', image: 'https://example.com/a.png' },
              { type: 'file', data: Buffer.from('%PDF'), mimeType: 'application/pdf', filename: 'a.pdf' },
            ],
          },
          { role: 'assistant', content: 'A logo.' },
        ];
        await store.save('img', messages);

        expect(readFileSync(join(dir, 'img.json'), 'utf8')).toContain('{"$bytes":"iVBORw=="}');
        const loaded = await store.load('img');
        expect(loaded).toEqual(structuredClone(messages)); // a Buffer comes back as a Uint8Array
        const parts = loaded?.[0].content as Array<{ image?: unknown; data?: unknown }>;
        expect(parts[1].image).toBeInstanceOf(Uint8Array);
        expect(parts[3].data).toBeInstanceOf(Uint8Array);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a corrupt session file with LOUSHO_SESSION_FILE_CORRUPT (LOU-D2)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
      try {
        writeFileSync(join(dir, 'bad.json'), '{"not":"an array"}');
        await expect(new FileSessionStore(dir).load('bad')).rejects.toMatchObject({
          message: expect.stringMatching(/is corrupt/),
          code: 'LOUSHO_SESSION_FILE_CORRUPT',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('providerValidPrefix', () => {
  const call: ToolCall = { id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } };
  it('drops an assistant tool-call turn without its results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [call] },
    ];
    expect(providerValidPrefix(messages)).toEqual([messages[0]]);
  });

  it('drops a partially answered batch and orphaned tool messages', () => {
    const two = [call, { ...call, id: 'c2' }];
    const partial: Message[] = [
      { role: 'assistant', content: '', toolCalls: two },
      { role: 'tool', content: '"x"', toolCallId: 'c1' },
    ];
    expect(providerValidPrefix(partial)).toEqual([]);
    expect(providerValidPrefix([{ role: 'tool', content: '"x"', toolCallId: 'c1' }])).toEqual([]);
  });
});

describe('AgentSession errors (LOU-D2)', () => {
  it('stream() without a streaming runner throws LOUSHO_SESSION_STREAM_UNSUPPORTED', () => {
    const session = new AgentSession(async () => {
      throw new Error('not called');
    });
    expect(() => session.stream('hi')).toThrow(expect.objectContaining({ code: 'LOUSHO_SESSION_STREAM_UNSUPPORTED' }));
  });
});
