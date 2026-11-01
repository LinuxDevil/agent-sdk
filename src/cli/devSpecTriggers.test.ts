/** `lousho dev` on a spec file starts the spec's cron triggers as schedules (v1 and v2), like a directory's `schedules/`. */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startDevServer, type DevServerHandle } from './dev';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';

const fixtures = path.join(__dirname, '__fixtures__');
const dirs: string[] = [];
let handle: DevServerHandle | undefined;

beforeAll(() => {
  // 'mock' is the provider both spec shapes resolve: v1's `provider.type` and
  // v2's `model: 'mock/…'` (registered like specToAgent.test.ts does).
  LLMProviderRegistry.register('mock', (config) => createMockProvider({ ...config, responses: ['ok'] }));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes `yaml` to a fresh <tmp>/agent.yaml under __fixtures__ (the watcher needs a real directory) and returns its path. */
function writeSpec(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(fixtures, 'tmp-dev-spec-'));
  dirs.push(dir);
  const file = path.join(dir, 'agent.yaml');
  fs.writeFileSync(file, yaml);
  return file;
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

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the dev server');
}

const V1_SPEC = `name: report-agent
prompt: You write reports.
provider:
  type: mock
  model: mock-1
triggers:
  - type: cron
    cron: "0 9 * * *"
    input: Write the report.
`;

const V2_SPEC = `version: 2
name: report-agent
model: mock/mock-1
instructions: You write reports.
triggers:
  - id: daily
    type: cron
    cron: "0 9 * * *"
    prompt: Write the report.
`;

const V2_WEBHOOK_SPEC = `version: 2
name: hook-agent
model: mock/mock-1
instructions: You answer webhooks.
triggers:
  - id: hook
    type: webhook
    path: /hook
    promptTemplate: Answer {{body}}.
`;

describe('lousho dev with a spec file that has triggers', () => {
  it("starts a v1 spec's cron trigger as a schedule named cron-1", async () => {
    const { timers, scheduler } = fakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(writeSpec(V1_SPEC), 0, '127.0.0.1', { debounceMs: 20, scheduler });
    expect(timers).toEqual({ started: 1, cancelled: 0 });
    expect(log).toHaveBeenCalledWith('[lousho dev] started schedules: cron-1');
  });

  it("starts a v2 spec's cron trigger as a schedule named after the trigger id", async () => {
    const { timers, scheduler } = fakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(writeSpec(V2_SPEC), 0, '127.0.0.1', { debounceMs: 20, scheduler });
    expect(timers).toEqual({ started: 1, cancelled: 0 });
    expect(log).toHaveBeenCalledWith('[lousho dev] started schedules: daily');
  });

  it('restarts the schedules once when the spec file is edited', async () => {
    const file = writeSpec(V2_SPEC);
    const { timers, scheduler } = fakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(file, 0, '127.0.0.1', { debounceMs: 20, scheduler });
    expect(timers).toEqual({ started: 1, cancelled: 0 });

    fs.writeFileSync(file, V2_SPEC.replace('You write reports.', 'You write weekly reports.'));
    const port = (handle.server.address() as { port: number }).port;
    const status = async () => (await (await fetch(`http://127.0.0.1:${port}/dev/status`)).json()) as { reloads: number };
    await waitFor(async () => (await status()).reloads >= 1);

    expect(timers).toEqual({ started: 2, cancelled: 1 });
  });

  it('--no-schedules starts none and logs the --no-schedules line', async () => {
    const { timers, scheduler } = fakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(writeSpec(V1_SPEC), 0, '127.0.0.1', { schedules: false, scheduler });
    expect(timers.started).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--no-schedules'));
  });

  it('logs that a v2 webhook trigger is not run by lousho dev', async () => {
    const { scheduler } = fakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(writeSpec(V2_WEBHOOK_SPEC), 0, '127.0.0.1', { debounceMs: 20, scheduler });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("trigger 'hook' (webhook) is not run by lousho dev; Studio runs it"));
  });
});
