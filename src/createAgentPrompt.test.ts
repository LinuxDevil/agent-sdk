/**
 * The `prompt` registry opt-in in createAgent(): 'name@version' (or
 * LOUSHO_PROMPT) fetches the run's instructions from the observe daemon at
 * build, embedded `instructions` are the fallback for an unreachable daemon,
 * and a landing fetch links every run to its version through a `prompt_use`
 * row (obs_id = the run's root span).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from './createAgent';
import { startObserveDaemon, type ObserveDaemon } from './observe/daemon';
import { publishPrompt } from './observe/promptClient';
import { observeExporterFromEnv } from './observe/reporter';
import { mockModel, type MockModel } from './testing';
import { textOf } from './providers/content';

const daemons: ObserveDaemon[] = [];

beforeEach(() => {
  vi.stubEnv('LOUSHO_OBSERVE_PROJECT', 'prompt-test');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (daemons.length > 0) await daemons.pop()?.close();
});

async function start(): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
  daemons.push(daemon);
  return daemon;
}

const base = (daemon: ObserveDaemon): string => `http://127.0.0.1:${daemon.port}`;

const systemPrompt = (model: MockModel, call = 0): string => textOf(model.calls[call].messages[0].content);

/** Flush + release the memoized env reporter for `name` (it is the only path prompt_use events take). */
async function closeReporter(name: string, url: string): Promise<void> {
  const env = { LOUSHO_OBSERVE: url, LOUSHO_OBSERVE_PROJECT: 'prompt-test' } as NodeJS.ProcessEnv;
  await observeExporterFromEnv({ agentName: name, env })?.close();
}

describe('createAgent({ prompt }) - registry fetch', () => {
  it('runs with the fetched registry text instead of the embedded instructions', async () => {
    const daemon = await start();
    vi.stubEnv('LOUSHO_OBSERVE', base(daemon));
    await publishPrompt(base(daemon), { name: 'mira', text: 'You are Mira from the registry.' });
    const model = mockModel(['ok']);

    const agent = createAgent({ name: 'prompt-agent-a', provider: model, prompt: 'mira@latest', instructions: 'You are embedded.' });
    await agent.send('hi');
    await closeReporter('prompt-agent-a', base(daemon));

    expect(systemPrompt(model)).toContain('You are Mira from the registry.');
    expect(systemPrompt(model)).not.toContain('You are embedded.');
  });

  it('emits a prompt_use event keyed by the run root span (obs_id)', async () => {
    const daemon = await start();
    vi.stubEnv('LOUSHO_OBSERVE', base(daemon));
    const { prompt } = await publishPrompt(base(daemon), { name: 'mira', text: 'registry text' });
    const model = mockModel(['ok']);

    const agent = createAgent({ name: 'prompt-agent-b', provider: model, prompt: 'mira@1' });
    await agent.send('hi');
    await closeReporter('prompt-agent-b', base(daemon));

    const uses = daemon.db.prepare('SELECT * FROM prompt_uses').all();
    expect(uses).toHaveLength(1);
    expect(String(uses[0].prompt_id)).toBe(prompt.prompt_id);
    expect(Number(uses[0].version)).toBe(1);
    const root = daemon.db.prepare('SELECT obs_id FROM observations WHERE parent_obs_id IS NULL').get();
    expect(root).toBeDefined();
    expect(String(uses[0].obs_id)).toBe(String(root?.obs_id));
  });

  it('opts in via LOUSHO_PROMPT when config.prompt is unset', async () => {
    const daemon = await start();
    vi.stubEnv('LOUSHO_OBSERVE', base(daemon));
    vi.stubEnv('LOUSHO_PROMPT', 'mira@latest');
    await publishPrompt(base(daemon), { name: 'mira', text: 'env fetched text' });
    const model = mockModel(['ok']);

    const agent = createAgent({ name: 'prompt-agent-c', provider: model });
    await agent.send('hi');
    await closeReporter('prompt-agent-c', base(daemon));

    expect(systemPrompt(model)).toContain('env fetched text');
  });
});

describe('createAgent({ prompt }) - fallback + conflicts', () => {
  it('uses the embedded instructions and warns once when the daemon is unreachable', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', 'http://127.0.0.1:1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);

    const agent = createAgent({ name: 'prompt-agent-d', provider: model, prompt: 'mira@1', instructions: 'You are embedded.' });
    await agent.send('hi');
    await closeReporter('prompt-agent-d', 'http://127.0.0.1:1');

    expect(systemPrompt(model)).toContain('You are embedded.');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('prompt'))).toHaveLength(1);
  });

  it('rejects with LOUSHO_PROMPT_UNRESOLVED when the prompt cannot be fetched and there is no fallback', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', 'http://127.0.0.1:1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    const agent = createAgent({ name: 'prompt-agent-e', provider: model, prompt: 'mira@latest' });
    await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_PROMPT_UNRESOLVED', message: expect.stringContaining('mira@latest') });
    await expect(agent.send('hi')).rejects.toThrow(/mira@latest.*LOUSHO_OBSERVE/s);
    await expect(agent.stream('hi').result).rejects.toMatchObject({ code: 'LOUSHO_PROMPT_UNRESOLVED' });
    expect(model.calls).toHaveLength(0);
    await closeReporter('prompt-agent-e', 'http://127.0.0.1:1');
  });

  it('rejects with LOUSHO_PROMPT_UNRESOLVED when the daemon answers 404 for the prompt', async () => {
    const daemon = await start();
    vi.stubEnv('LOUSHO_OBSERVE', base(daemon));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    await expect(createAgent({ name: 'prompt-agent-404', provider: model, prompt: 'ghost@latest' }).send('hi')).rejects.toMatchObject({
      code: 'LOUSHO_PROMPT_UNRESOLVED',
    });
    expect(model.calls).toHaveLength(0);
    await closeReporter('prompt-agent-404', base(daemon));
  });

  it('rejects with LOUSHO_PROMPT_UNRESOLVED when no collector is configured and there is no fallback', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', '');
    const model = mockModel(['ok']);
    await expect(createAgent({ name: 'prompt-agent-nocollector', provider: model, prompt: 'mira@latest' }).send('hi')).rejects.toMatchObject({
      code: 'LOUSHO_PROMPT_UNRESOLVED',
      message: expect.stringContaining('LOUSHO_OBSERVE'),
    });
    expect(model.calls).toHaveLength(0);
  });

  it('rejects with LOUSHO_PROMPT_UNRESOLVED for a LOUSHO_PROMPT env ref with no instructions', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', 'http://127.0.0.1:1');
    vi.stubEnv('LOUSHO_PROMPT', 'envref@latest');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    await expect(createAgent({ name: 'prompt-agent-envref', provider: model }).send('hi')).rejects.toMatchObject({
      code: 'LOUSHO_PROMPT_UNRESOLVED',
      message: expect.stringContaining('envref@latest'),
    });
    expect(model.calls).toHaveLength(0);
    await closeReporter('prompt-agent-envref', 'http://127.0.0.1:1');
  });

  it('retries a failed resolution: the next run succeeds once the daemon is reachable', async () => {
    const first = await start();
    const port = first.port;
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);
    const url = `http://127.0.0.1:${port}`;
    vi.stubEnv('LOUSHO_OBSERVE', url);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    const agent = createAgent({ name: 'prompt-agent-retry', provider: model, prompt: 'mira@latest' });
    await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_PROMPT_UNRESOLVED' });

    const daemon = await startObserveDaemon({ dbPath: ':memory:', port });
    daemons.push(daemon);
    await publishPrompt(url, { name: 'mira', text: 'Registry text after recovery.' });
    await agent.send('hi');
    expect(systemPrompt(model)).toContain('Registry text after recovery.');
    await closeReporter('prompt-agent-retry', url);
  });

  it('falls back to instructions when they exist (no collector: warning text unchanged)', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    await createAgent({ name: 'prompt-agent-fb', provider: model, prompt: 'mira@1', instructions: 'You are embedded.' }).send('hi');
    expect(systemPrompt(model)).toContain('You are embedded.');
    expect(String(warn.mock.calls[0][0])).toContain('the embedded instructions are used instead.');
  });

  it('still treats a non-ref prompt + instructions as the conflicting-aliases error', () => {
    // @ts-expect-error - the union forbids a non-ref `prompt` beside `instructions`; the runtime guard still covers JS callers.
    expect(() => createAgent({ provider: mockModel(['ok']), instructions: 'a', prompt: 'plain text prompt' })).toThrow(
      /both 'instructions' and 'prompt'/
    );
  });

  it('a non-ref prompt stays the deprecated instructions alias', async () => {
    const model = mockModel(['ok']);
    await createAgent({ name: 'prompt-agent-f', provider: model, prompt: 'Legacy alias text.' }).send('hi');
    expect(systemPrompt(model)).toContain('Legacy alias text.');
  });
});
