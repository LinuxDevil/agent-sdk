import { afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { describeMemoryProviderContract } from './providerContract';
import { defineMemory, fileMemory, inMemoryMemory, type MemoryProvider } from './index';

const systemOf = (call: MockRequest | undefined): string =>
  String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);
const lastToolResult = (call: MockRequest): unknown => JSON.parse(String(call.messages.at(-1)?.content));

async function seeded(texts: string[], key = 'global'): Promise<MemoryProvider> {
  const provider = inMemoryMemory();
  for (const text of texts) await provider.add(key, { text });
  return provider;
}

describe('defineMemory', () => {
  it('applies defaults and validates', () => {
    const slot = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
    expect(slot.recall).toEqual({ onSessionStart: true, maxItems: 10, query: 'none' });
    expect(slot.expose).toEqual({ remember: true, recall: true });
    expect(Object.isFrozen(slot)).toBe(true);
    expect(() => defineMemory({ name: 'my notes', scope: 'global', provider: inMemoryMemory() })).toThrow(/invalid name/);
    expect(() => defineMemory({ name: 'n', scope: 'global', provider: undefined as never })).toThrow(/needs a provider/);
    expect(() =>
      defineMemory({ name: 'n', scope: 'global', provider: inMemoryMemory(), recall: { maxItems: 0 } })
    ).toThrow(/maxItems must be a positive integer/);
  });

  it('rejects duplicate slot names and taken tool names in createAgent', () => {
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
    expect(() => createAgent({ provider: mockModel([]), memory: [notes, notes] })).toThrow(/two memory slots are named 'notes'/);
    const taken = defineTool({ name: 'recall_notes', description: 'x', input: z.object({}), execute: () => 'x' });
    expect(() => createAgent({ provider: mockModel([]), tools: [taken], memory: [notes] })).toThrow(
      /tool named 'recall_notes' is already registered/
    );
  });
});

describe('createAgent({ memory })', () => {
  it('recalls into the system prompt on session start, once per run, bounded by maxItems', async () => {
    const provider = await seeded(['likes tea', 'lives in Oslo', 'name is Ali']);
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { maxItems: 2 } });
    const ping = defineTool({ name: 'ping', description: 'ping', input: z.object({}), execute: () => 'pong' });
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }, 'hi Ali', 'again']);
    const agent = createAgent({ instructions: 'Be brief.', provider: model, tools: [ping], memory: [notes] });

    const session = agent.session();
    await session.send('hello');
    const block = '<memory name="notes">\n- name is Ali\n- lives in Oslo\n</memory>';
    expect(systemOf(model.calls[0])).toBe(`Be brief.\n\n${block}`);
    // The run's later model calls keep it; the session transcript does not store it.
    expect(systemOf(model.calls[1])).toBe(`Be brief.\n\n${block}`);
    expect(JSON.stringify(session.messages)).not.toContain('<memory');

    await session.send('and now?');
    expect(systemOf(model.calls[2])).toBe(`Be brief.\n\n${block}`);
  });

  it('remember_ stores and recall_ returns', async () => {
    const provider = inMemoryMemory();
    const notes = defineMemory({ name: 'notes', description: 'user preferences', scope: 'global', provider });
    const model = mockModel([
      { toolCalls: [{ name: 'remember_notes', args: { text: 'prefers green tea' } }] },
      { toolCalls: [{ name: 'recall_notes', args: { query: 'tea' } }] },
      'done',
    ]);
    const agent = createAgent({ provider: model, memory: [notes] });
    await agent.send('remember that I prefer green tea');

    expect(toolsOf(model.calls[0])).toEqual(['remember_notes', 'recall_notes']);
    expect(model.calls[0].tools?.[0].function.description).toContain('It holds: user preferences');
    const [item] = await provider.list('global');
    expect(item.text).toBe('prefers green tea');
    expect(lastToolResult(model.calls[1])).toEqual({ remembered: item.id });
    expect(lastToolResult(model.calls[2])).toEqual({
      items: [{ id: item.id, text: 'prefers green tea', createdAt: item.createdAt }],
    });
  });

  it("keeps scope: 'session' memory per session id", async () => {
    const provider = inMemoryMemory();
    const notes = defineMemory({ name: 'notes', scope: 'session', provider });
    const model = mockModel([{ toolCalls: [{ name: 'remember_notes', args: { text: 'A-secret' } }] }, 'ok'], {
      onExhausted: 'repeat-last',
    });
    const agent = createAgent({ provider: model, memory: [notes] });

    await agent.session({ id: 'a' }).send('remember');
    await agent.session({ id: 'b' }).send('hi');
    expect(systemOf(model.lastCall)).not.toContain('<memory');
    await agent.session({ id: 'a' }).send('hi');
    expect(systemOf(model.lastCall)).toContain('<memory name="notes">\n- A-secret\n</memory>');
    expect(await provider.list('session:b')).toEqual([]);

    // No session id: the slot is off for that run (no tools, no recall).
    await agent.send('hi');
    expect(toolsOf(model.lastCall)).toEqual([]);
  });

  it('resolves a scope function from send() metadata and sessionId, also when streaming', async () => {
    const provider = await seeded(['u1 fact'], 'user:u1');
    const notes = defineMemory({
      name: 'user',
      scope: ({ metadata }) => (metadata?.userId ? `user:${String(metadata.userId)}` : undefined),
      provider,
    });
    const model = mockModel(['ok'], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, memory: [notes], store: memoryStore() });

    await agent.stream('hi', { metadata: { userId: 'u1' } }).result;
    expect(systemOf(model.lastCall)).toContain('- u1 fact');
    // A durable run continued under the same sessionId gets one fresh block, not two.
    await agent.send('one', { sessionId: 'job', metadata: { userId: 'u1' } });
    await agent.send('two', { sessionId: 'job', metadata: { userId: 'u1' } });
    expect(systemOf(model.lastCall).match(/<memory/g)).toHaveLength(1);
    await agent.send('hi', { metadata: { userId: 'u2' } });
    expect(systemOf(model.lastCall)).not.toContain('<memory');
  });

  it('keeps the recalled block, without memory tools, in a run continued after an approval', async () => {
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded(['likes tea']) });
    const send = defineTool({ name: 'send', description: 's', input: z.object({}), needsApproval: true, execute: () => 'sent' });
    const model = mockModel([{ toolCalls: [{ name: 'send' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [send], memory: [notes] });
    const paused = await agent.send('send it');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(systemOf(model.lastCall)).toContain('- likes tea');
    expect(toolsOf(model.lastCall)).toEqual(['send']);
  });

  it("passes the last input as the query with query: 'last-input'", async () => {
    const provider = await seeded(['likes tea', 'owns a cat']);
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { query: 'last-input' } });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('Any cat food tips?');
    expect(systemOf(model.lastCall)).toContain('<memory name="notes">\n- owns a cat\n</memory>');
  });

  it('expose: { remember: false } hides the tool; onSessionStart: false skips recall', async () => {
    const provider = await seeded(['likes tea']);
    const notes = defineMemory({
      name: 'notes',
      scope: 'global',
      provider,
      expose: { remember: false },
      recall: { onSessionStart: false },
    });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');
    expect(toolsOf(model.lastCall)).toEqual(['recall_notes']);
    expect(systemOf(model.lastCall)).not.toContain('<memory');
  });
});

describeMemoryProviderContract('inMemoryMemory', (options) => inMemoryMemory(options));

const contractDirs: string[] = [];
afterAll(() => Promise.all(contractDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
describeMemoryProviderContract('fileMemory', async (options) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loushy-memory-contract-'));
  contractDirs.push(dir);
  return fileMemory({ dir, ...options });
});

describe('memory providers', () => {
  it('fileMemory persists through JSON files, one per scope key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'loushy-memory-'));
    try {
      const first = fileMemory({ dir: path.join(dir, 'mem'), maxItems: 2 });
      expect(await first.list('session:a')).toEqual([]);
      await first.add('session:a', { text: 'old', metadata: { source: 'test' } });
      await first.add('session:a', { text: 'mid' });
      const newest = await first.add('session:a', { text: 'new' });
      await first.add('global', { text: 'shared' });

      const reopened = fileMemory({ dir: path.join(dir, 'mem') });
      expect((await reopened.list('session:a')).map((i) => i.text)).toEqual(['new', 'mid']);
      expect(await readdir(path.join(dir, 'mem'))).toEqual(['global.json', 'session%3Aa.json']);
      await reopened.remove('session:a', newest.id);
      expect((await first.list('session:a')).map((i) => i.text)).toEqual(['mid']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
