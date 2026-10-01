/**
 * LOU-D45: Forge's FileCheckpointStore keeps the same bounded history ring
 * as the SDK's stores - the SDK's own history contract suite, run against it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileCheckpointStore } from '../checkpointStore';
import type { Checkpoint } from '@loushy/build-ai-agent';
import { describeCheckpointHistoryContract } from '../../../../src/execution/__fixtures__/checkpointHistoryContract';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describeCheckpointHistoryContract('FileCheckpointStore (Agent Forge)', (options) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d45-store-'));
  dirs.push(dir);
  return new FileCheckpointStore(dir, options);
});

describe('FileCheckpointStore history on disk (LOU-D43.2)', () => {
  const checkpoint = (stepIndex: number): Checkpoint => ({
    agentId: 'bot',
    sessionId: 'bot',
    stepIndex,
    messages: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });

  it('treats a partially written history file as no history, keeps the latest checkpoint and recovers on the next save', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d43-2-store-'));
    dirs.push(dir);
    const store = new FileCheckpointStore(dir);
    await store.save('bot', checkpoint(1));
    const historyFile = path.join(dir, '.loushy', 'agents', 'bot', 'checkpoint-history', 'bot.json');
    fs.writeFileSync(historyFile, '[{"step":1,"savedAt":"2026-01-01T00:0');

    expect(await store.history('bot')).toEqual([]);
    expect((await store.load('bot'))?.stepIndex).toBe(1);
    await store.save('bot', checkpoint(2));
    expect((await store.history('bot')).map((entry) => entry.step)).toEqual([2]);
    expect(fs.readdirSync(path.dirname(historyFile)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
