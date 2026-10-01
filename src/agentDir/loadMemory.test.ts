import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadAgentDir, resolveAgentDir } from './index';
import { SDKError } from '../execution/errors';
import { defineMemory, inMemoryMemory } from '../memory';
import { mockModel, type MockRequest } from '../testing';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);
const systemOf = (call: MockRequest | undefined): string =>
  String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);

describe('memory/ in an agent directory (LOU-W6.3)', () => {
  it('loads memory/*.ts: the name defaults to the file name, an explicit name wins', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('memory'), { provider: mockModel(['x']) });
    expect(manifest.memory).toEqual(['notes', 'user-prefs']);
    expect(config.memory?.map((m) => m.name)).toEqual(['notes', 'user-prefs']);
    expect(config.memory?.[0].description).toBe('Facts to keep');
    expect(config.memory?.[1].recall.maxItems).toBe(3);
  });

  it('a directory without memory/ behaves as before', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('full'), { provider: mockModel(['x']) });
    expect(manifest.memory).toEqual([]);
    expect(config).not.toHaveProperty('memory');
  });

  it('rejects a default export that is not a slot with a coded error naming the file', async () => {
    const failure = await resolveAgentDir(fixture('err-bad-memory'), { provider: mockModel(['x']) }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SDKError);
    expect((failure as SDKError).code).toBe('LOUSHY_MEMORY_INVALID');
    expect((failure as SDKError).message).toMatch(/broken\.ts: the default export must be a memory slot/);
  });

  it('a directory agent remembers in one session and recalls in another', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'remember_notes', args: { text: 'prefers green tea' } }] },
      'noted',
      'green tea',
    ]);
    const agent = await loadAgentDir(fixture('memory'), { provider: model });
    await agent.session().send('remember that I prefer green tea');
    expect(toolsOf(model.calls[0])).toEqual(expect.arrayContaining(['remember_notes', 'recall_notes']));

    await agent.session().send('what tea do I like?');
    expect(systemOf(model.lastCall)).toContain('<memory name="notes">\n- prefers green tea\n</memory>');
  });

  it('override memory wins a name clash and is merged with the other directory slots', async () => {
    const mine = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory(), description: 'mine' });
    const extra = defineMemory({ name: 'extra', scope: 'global', provider: inMemoryMemory() });
    const { config, manifest } = await resolveAgentDir(fixture('memory'), { provider: mockModel(['x']), memory: [mine, extra] });
    expect(config.memory?.map((m) => m.name)).toEqual(['user-prefs', 'notes', 'extra']);
    expect(config.memory?.find((m) => m.name === 'notes')).toBe(mine);
    expect(manifest.memory).toEqual(['notes', 'user-prefs']);
  });
});
