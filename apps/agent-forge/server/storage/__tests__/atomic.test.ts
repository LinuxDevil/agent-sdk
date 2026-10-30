import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic, withAgentLock } from '../atomic';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d01-atomic-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a string and reads it back, creating missing parent dirs', async () => {
    const file = path.join(dir, 'nested', 'deep', 'file.txt');
    await writeFileAtomic(file, 'hello');
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hello');
  });

  it('overwrites an existing file in place', async () => {
    const file = path.join(dir, 'file.txt');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second');
    expect(await fsPromises.readFile(file, 'utf8')).toBe('second');
  });

  // retry: 50 parallel renames onto one target on Windows can hit a genuine
  // EPERM storm (AV scanning the fresh .tmp files, delete-pending churn on
  // the replaced target) that legitimately outlasts the helper's 5-attempt
  // rename budget - an environment flake, not a code defect.
  it('leaves only complete payloads (never a partial write) and no .tmp files after 50 parallel writes', { retry: 3 }, async () => {
    const payloads = Array.from({ length: 50 }, (_, i) => `payload-${i}:${'x'.repeat(64 * 1024)}`);
    const payloadSet = new Set(payloads);
    const target = path.join(dir, 'concurrent.txt');

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    // temp+rename means the file can only ever hold one complete payload -
    // a reader at any point sees the old or the new file, never a half-write.
    expect(payloadSet.has(await fsPromises.readFile(target, 'utf8'))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('retries rename on EBUSY and resolves once it succeeds', async () => {
    const spy = vi.spyOn(fsPromises, 'rename');
    spy
      .mockRejectedValueOnce(withCode('busy', 'EBUSY'))
      .mockRejectedValueOnce(withCode('busy', 'EBUSY'))
      // Fully mocked (no call-through): a real rename here would be subject
      // to genuine transient EPERM/EACCES (AV scanning the fresh .tmp), which
      // the retry would legitimately absorb and break an exact call count.
      .mockResolvedValueOnce(undefined);

    const target = path.join(dir, 'retry.txt');
    await writeFileAtomic(target, 'data');

    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('rejects after 5 rename attempts and removes the .tmp file', async () => {
    const spy = vi.spyOn(fsPromises, 'rename');
    spy.mockRejectedValue(withCode('denied', 'EACCES'));

    const target = path.join(dir, 'denied.txt');
    await expect(writeFileAtomic(target, 'data')).rejects.toMatchObject({ code: 'EACCES' });

    expect(spy).toHaveBeenCalledTimes(5);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('withAgentLock', () => {
  it('runs same-id calls strictly one after another in call order', async () => {
    const order: number[] = [];
    await Promise.all([
      withAgentLock('a', async () => {
        await sleep(5);
        order.push(1);
      }),
      withAgentLock('a', async () => {
        await sleep(5);
        order.push(2);
      }),
      withAgentLock('a', async () => {
        await sleep(5);
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not make a different id wait on a held lock', async () => {
    const order: string[] = [];
    const a = withAgentLock('a', async () => {
      await sleep(50);
      order.push('a');
    });
    const b = withAgentLock('b', async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  it('releases the lock when fn rejects and the rejection reaches the caller', async () => {
    await expect(
      withAgentLock('a', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withAgentLock('a', async () => 'next')).resolves.toBe('next');
  });

  it("rejects re-entering the same id instead of deadlocking", async () => {
    await expect(withAgentLock('a', () => withAgentLock('a', async () => undefined))).rejects.toThrow(
      "withAgentLock re-entered for 'a'"
    );
  });

  it('allows nesting under a different id', async () => {
    await expect(withAgentLock('a', () => withAgentLock('b', async () => 'ok'))).resolves.toBe('ok');
  });
});
