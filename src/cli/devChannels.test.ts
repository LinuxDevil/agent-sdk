/** LOU-P8.2: `loushy dev` mounts an agent directory's channels and starts its schedules, and swaps both on reload. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startDevServer, parseDevArgs, type DevServerHandle } from './dev';
import { mockModel } from '../testing';

const fixtures = path.join(__dirname, '__fixtures__');
const copies: string[] = [];
let handle: DevServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const copy of copies.splice(0)) fs.rmSync(copy, { recursive: true, force: true });
});

function copyFixture(): string {
  const copy = fs.mkdtempSync(path.join(fixtures, 'tmp-dev-channels-'));
  copies.push(copy);
  fs.cpSync(path.join(fixtures, 'dev-channels'), copy, { recursive: true });
  return copy;
}

/** A scheduler that records timers instead of waiting: `started` counts them, `cancelled` the stopped ones. */
function fakeTimers() {
  const timers = { started: 0, cancelled: 0 };
  const setTimer = () => {
    timers.started += 1;
    return () => void (timers.cancelled += 1);
  };
  return { timers, scheduler: { setTimer } };
}

const hook = async (h: DevServerHandle, text = 'hi') => {
  const res = await fetch(`http://127.0.0.1:${(h.server.address() as { port: number }).port}/channels/hook`, { method: 'POST', body: text });
  return { status: res.status, body: (await res.json()) as { reply: string } };
};

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the dev server');
}

describe('loushy dev with an agent directory that has channels and schedules', () => {
  it('mounts the channels and starts the schedules; a reload replaces the channel and restarts the schedules once', async () => {
    const dir = copyFixture();
    const { timers, scheduler } = fakeTimers();
    const provider = mockModel(['pong', 'pong']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider }, debounceMs: 20, scheduler });

    expect((await hook(handle)).body.reply.startsWith('v1:pong')).toBe(true);
    expect(timers).toEqual({ started: 1, cancelled: 0 });

    const file = path.join(dir, 'channels', 'hook.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('v1:', 'v2:'));
    const status = async () => (await (await fetch(`http://127.0.0.1:${(handle!.server.address() as { port: number }).port}/dev/status`)).json()) as { reloads: number };
    await waitFor(async () => (await status()).reloads >= 1);

    expect((await hook(handle)).body.reply.startsWith('v2:')).toBe(true);
    // The old schedule was stopped, one new one started: never two live timers.
    expect(timers).toEqual({ started: 2, cancelled: 1 });

    await handle.close();
    handle = undefined;
    expect(timers).toEqual({ started: 2, cancelled: 2 });
    log.mockRestore();
  });

  it('--no-schedules mounts the channels but starts nothing', async () => {
    const { timers, scheduler } = fakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(copyFixture(), 0, '127.0.0.1', {
      overrides: { provider: mockModel(['pong']) },
      schedules: false,
      scheduler,
    });
    expect((await hook(handle)).status).toBe(200);
    expect(timers.started).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--no-schedules'));
    log.mockRestore();
  });

  it('parses --no-schedules', () => {
    expect(parseDevArgs(['./a', '--no-schedules']).noSchedules).toBe(true);
    expect(parseDevArgs(['./a']).noSchedules).toBeUndefined();
  });
});
