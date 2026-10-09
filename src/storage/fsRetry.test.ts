import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../providers/llm';
import { fileStore } from './fileStore';
import { FileSessionStore } from '../session/sessionStore';
import { withFsRetry } from './fsRetry';

const fsError = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename 'a' -> 'b'`), { code });

describe('withFsRetry (Eve DUR-F13)', () => {
  it('retries EPERM / EACCES / EBUSY and returns the result', async () => {
    const codes = ['EPERM', 'EACCES', 'EBUSY'];
    let calls = 0;
    const result = await withFsRetry('replace b', async () => {
      if (calls < codes.length) throw fsError(codes[calls++]);
      return 'ok';
    }, [0, 0, 0]);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('wraps a failure that outlasts the retries as LOUSHO_STORAGE_FAILED with the cause', async () => {
    const cause = fsError('EPERM');
    const failing = withFsRetry('replace b', async () => Promise.reject(cause), [0, 0]);
    await expect(failing).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED', cause });
    await expect(withFsRetry('replace b', async () => Promise.reject(cause), [0])).rejects.toThrow(/Could not replace b: EPERM/);
  });

  it('rethrows other errors at once', async () => {
    let calls = 0;
    const enoent = fsError('ENOENT');
    await expect(
      withFsRetry('read a', async () => {
        calls++;
        throw enoent;
      })
    ).rejects.toBe(enoent);
    expect(calls).toBe(1);
  });
});

describe('fileStore under concurrent use (Eve DUR-F13)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('two stores on one directory save and load the same session and checkpoint without filesystem errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dur-f13-'));
    dirs.push(dir);
    const a = fileStore(dir);
    const b = fileStore(dir);
    const sessions = new FileSessionStore(join(dir, 'plain'));
    const msgs = (n: number): Message[] =>
      Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${n}-${i}`.repeat(20) }));
    const failures: unknown[] = [];
    for (let round = 0; round < 30; round++) {
      const ops = [
        a.sessions.save('chat', msgs(round)),
        b.sessions.save('chat', msgs(round + 1000)),
        a.sessions.load('chat'),
        sessions.save('chat', msgs(round)),
        sessions.save('chat', msgs(round + 1)),
        sessions.load('chat'),
        b.checkpoints.save('chat.turn-0', { agentId: 'x', sessionId: 'chat.turn-0', stepIndex: round, messages: msgs(round), toolCalls: [], usage: {} } as never),
        a.checkpoints.load('chat.turn-0'),
      ];
      for (const settled of await Promise.allSettled(ops)) if (settled.status === 'rejected') failures.push(settled.reason);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
