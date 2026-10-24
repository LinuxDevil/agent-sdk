/**
 * The prompt registry end to end over real HTTP: publish/version/dedupe,
 * `latest` resolved daemon side, history + list + `uses` counts, the
 * agent-side client (`fetchPrompt`, `registryPrompt` fallback), and the
 * reporter's `prompt_use` event emitted on the run's root span.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startObserveDaemon, type ObserveDaemon } from './daemon';
import { fetchPrompt, parsePromptRef, publishPrompt, registryPrompt } from './promptClient';
import { observeExporter, type ObserveReporter } from './reporter';
import type { IngestEvent } from './envelope';
import type { Span } from '../execution/tracing';

const daemons: ObserveDaemon[] = [];
const reporters: ObserveReporter[] = [];
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-prompts-'));
});

afterEach(async () => {
  await Promise.all(reporters.splice(0).map((r) => r.close().catch(() => undefined)));
  while (daemons.length > 0) await daemons.pop()?.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function start(opts: Parameters<typeof startObserveDaemon>[0] = {}): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0, ...opts });
  daemons.push(daemon);
  return daemon;
}

const url = (daemon: ObserveDaemon, path: string): string => `http://127.0.0.1:${daemon.port}${path}`;
const base = (daemon: ObserveDaemon): string => url(daemon, '');

const post = (daemon: ObserveDaemon, path: string, body: unknown): Promise<Response> =>
  fetch(url(daemon, path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const get = (daemon: ObserveDaemon, path: string): Promise<Response> => fetch(url(daemon, path));

describe('POST /api/v1/prompts', () => {
  it('publishes versions, dedupes an identical republish, and still versions a rollback', async () => {
    const daemon = await start();
    const v1 = await post(daemon, '/api/v1/prompts', { name: 'mira', text: 'You are Mira.', labels: ['prod'], variables: ['who'] });
    expect(v1.status).toBe(201);
    const p1 = (await v1.json()) as { prompt: { prompt_id: string; version: number; hash: string }; created: boolean };
    expect(p1.created).toBe(true);
    expect(p1.prompt.version).toBe(1);
    expect(typeof p1.prompt.hash).toBe('string');

    const same = await post(daemon, '/api/v1/prompts', { name: 'mira', text: 'You are Mira.', labels: ['prod'], variables: ['who'] });
    expect(same.status).toBe(200);
    expect((await same.json()) as { created: boolean }).toMatchObject({ created: false });

    const v2 = await post(daemon, '/api/v1/prompts', { name: 'mira', text: 'You are Mira 2.' });
    expect((await v2.json()) as { prompt: { version: number } }).toMatchObject({ prompt: { version: 2 } });

    // republishing the older text is a real new version (a rollback), not a dedupe hit
    const rollback = await post(daemon, '/api/v1/prompts', { name: 'mira', text: 'You are Mira.', labels: ['prod'], variables: ['who'] });
    expect((await rollback.json()) as { prompt: { version: number }; created: boolean }).toMatchObject({ prompt: { version: 3 }, created: true });
  });

  it('rejects a bad body (missing text, illegal name) with 400', async () => {
    const daemon = await start();
    expect((await post(daemon, '/api/v1/prompts', { name: 'x' })).status).toBe(400);
    expect((await post(daemon, '/api/v1/prompts', { name: 'has space', text: 't' })).status).toBe(400);
    expect((await post(daemon, '/api/v1/prompts', { name: 'a/b', text: 't' })).status).toBe(400);
  });
});

describe('GET /api/v1/prompts reads', () => {
  it('resolves name@version and name@latest, serves history and the one-row-per-name list', async () => {
    const daemon = await start();
    await publishPrompt(base(daemon), { name: 'mira', text: 'v1 text' });
    await publishPrompt(base(daemon), { name: 'mira', text: 'v2 text' });
    await publishPrompt(base(daemon), { name: 'ghost', text: 'ghost v1' });

    const latest = (await (await get(daemon, '/api/v1/prompts/mira/latest')).json()) as { prompt: { version: number; text: string } };
    expect(latest.prompt.version).toBe(2);
    expect(latest.prompt.text).toBe('v2 text');

    const pinned = (await (await get(daemon, '/api/v1/prompts/mira/1')).json()) as { prompt: { text: string } };
    expect(pinned.prompt.text).toBe('v1 text');

    const history = (await (await get(daemon, '/api/v1/prompts/mira')).json()) as { versions: { version: number; text: string }[] };
    expect(history.versions.map((v) => [v.version, v.text])).toEqual([
      [2, 'v2 text'],
      [1, 'v1 text'],
    ]);

    const list = (await (await get(daemon, '/api/v1/prompts')).json()) as { prompts: { name: string; version: number; versions: number }[] };
    expect(list.prompts.map((p) => [p.name, p.version, p.versions])).toEqual([
      ['ghost', 1, 1],
      ['mira', 2, 2],
    ]);
  });

  it('404s a missing prompt or version and 400s a non-integer non-latest version', async () => {
    const daemon = await start();
    await publishPrompt(base(daemon), { name: 'mira', text: 't' });
    expect((await get(daemon, '/api/v1/prompts/nope/latest')).status).toBe(404);
    expect((await get(daemon, '/api/v1/prompts/mira/9')).status).toBe(404);
    expect((await get(daemon, '/api/v1/prompts/nope')).status).toBe(404);
    expect((await get(daemon, '/api/v1/prompts/mira/abc')).status).toBe(400);
  });

  it('counts prompt_uses rows as runs that used each version', async () => {
    const daemon = await start();
    const { prompt } = await publishPrompt(base(daemon), { name: 'mira', text: 't' });
    await post(daemon, '/api/v1/ingest', {
      batch: [
        { type: 'prompt_use', data: { obs_id: 'root-1', prompt_id: prompt.prompt_id, version: 1 } },
        { type: 'prompt_use', data: { obs_id: 'root-2', prompt_id: prompt.prompt_id, version: 1 } },
      ],
    });
    const history = (await (await get(daemon, '/api/v1/prompts/mira')).json()) as { versions: { uses: number }[] };
    expect(history.versions[0].uses).toBe(2);
    const list = (await (await get(daemon, '/api/v1/prompts')).json()) as { prompts: { uses: number }[] };
    expect(list.prompts[0].uses).toBe(2);
  });
});

describe('parsePromptRef + fetchPrompt', () => {
  it('parses name@int and name@latest, rejects bare names and prose', () => {
    expect(parsePromptRef('mira@3')).toEqual({ name: 'mira', version: 3 });
    expect(parsePromptRef('mira@latest')).toEqual({ name: 'mira', version: 'latest' });
    expect(parsePromptRef('mira')).toBeUndefined();
    expect(parsePromptRef('You are helpful.')).toBeUndefined();
    expect(parsePromptRef('a/b@1')).toBeUndefined();
    expect(parsePromptRef('@1')).toBeUndefined();
    expect(parsePromptRef(undefined)).toBeUndefined();
  });

  it('fetchPrompt resolves a ref against the daemon', async () => {
    const daemon = await start();
    await publishPrompt(base(daemon), { name: 'mira', text: 'hello' });
    const resolved = await fetchPrompt(base(daemon), { name: 'mira', version: 'latest' });
    expect(resolved.text).toBe('hello');
    await expect(fetchPrompt(base(daemon), { name: 'mira', version: 9 })).rejects.toMatchObject({ code: 'LOUSHO_REMOTE_REQUEST_FAILED' });
  });
});

describe('registryPrompt', () => {
  it('serves the fetched text and exposes the prompt_use ref', async () => {
    const daemon = await start();
    const { prompt } = await publishPrompt(base(daemon), { name: 'mira', text: 'registry text' });
    const env = { LOUSHO_OBSERVE: base(daemon) } as NodeJS.ProcessEnv;
    const source = registryPrompt('mira@latest', { env });
    expect(source).toBeDefined();
    await expect(source!.text(async () => 'embedded')).resolves.toBe('registry text');
    expect(source!.use()).toEqual({ prompt_id: prompt.prompt_id, version: 1 });
  });

  it('falls back to the embedded instructions (warn once) when the daemon is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { LOUSHO_OBSERVE: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv;
    const source = registryPrompt('mira@1', { env, timeoutMs: 300 })!;
    await expect(source.text(async () => 'embedded')).resolves.toBe('embedded');
    await expect(source.text(async () => 'embedded')).resolves.toBe('embedded');
    expect(source.use()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is undefined when LOUSHO_OBSERVE names no daemon or the value is not a ref', () => {
    expect(registryPrompt('mira@1', { env: {} as NodeJS.ProcessEnv })).toBeUndefined();
    expect(registryPrompt('not a ref', { env: { LOUSHO_OBSERVE: 'http://x' } as NodeJS.ProcessEnv })).toBeUndefined();
  });
});

describe('reporter prompt_use', () => {
  function reporter(over: Parameters<typeof observeExporter>[0] = {}): { r: ObserveReporter; posted: IngestEvent[] } {
    const posted: IngestEvent[] = [];
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
      posted.push(...(JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch);
      return new Response('{}', { status: 202 });
    });
    const r = observeExporter({
      cwd,
      url: 'http://127.0.0.1:1',
      flushIntervalMs: 0,
      heartbeatIntervalMs: 0,
      registerExitHooks: false,
      fetchFn: fetchFn as unknown as typeof fetch,
      ...over,
    });
    reporters.push(r);
    return { r, posted };
  }

  const span = (over: Partial<Span>): Span => ({ id: 's', name: 'invoke_agent a', attributes: {}, startTime: 1, ...over });

  it('emits prompt_use with obs_id = the root span id when the provider resolves', async () => {
    const { r, posted } = reporter({ promptUse: () => ({ prompt_id: 'p-1', version: 2 }) });
    r.onSpanStart(span({ id: 'root' }));
    r.onSpanStart(span({ id: 'child', parentId: 'root' }));
    r.onSpanEnd(span({ id: 'child', parentId: 'root', endTime: 5 }));
    r.onSpanEnd(span({ id: 'root', endTime: 6 }));
    await r.close();
    const uses = posted.filter((e): e is Extract<IngestEvent, { type: 'prompt_use' }> => e.type === 'prompt_use');
    expect(uses).toHaveLength(1);
    expect(uses[0].data).toEqual({ obs_id: 'root', prompt_id: 'p-1', version: 2 });
  });

  it('emits nothing while the provider returns undefined (fetch pending or failed)', async () => {
    const { r, posted } = reporter({ promptUse: () => undefined });
    r.onSpanStart(span({ id: 'root' }));
    await r.close();
    expect(posted.filter((e) => e.type === 'prompt_use')).toHaveLength(0);
  });

  it('does not re-emit for a child run parented under a span', async () => {
    const { r, posted } = reporter({ promptUse: () => ({ prompt_id: 'p-1' }) });
    r.onSpanStart(span({ id: 'delegated', parentId: 'unseen-parent' }));
    await r.close();
    expect(posted.filter((e) => e.type === 'prompt_use')).toHaveLength(0);
  });
});
