/**
 * `lousho prompt` against a real daemon on an ephemeral port: push publishes
 * a version (from a file, with the basename defaulting the name, or stdin),
 * list shows the registry, get resolves name[@version].
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startObserveDaemon, type ObserveDaemon } from '../observe/daemon';
import { runPrompt, type PromptDeps } from './prompt';

const daemons: ObserveDaemon[] = [];
let cwd: string;
let out: string[];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-prompt-cli-'));
  out = [];
});

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function start(): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
  daemons.push(daemon);
  return daemon;
}

const base = (daemon: ObserveDaemon): string => `http://127.0.0.1:${daemon.port}`;

function deps(over: Partial<PromptDeps> = {}): PromptDeps {
  return { cwd, env: {} as NodeJS.ProcessEnv, log: (text) => out.push(text), readStdin: async () => 'from stdin', ...over };
}

describe('lousho prompt', () => {
  it('push publishes a file as the next version (basename name default), get and list read it back', async () => {
    const daemon = await start();
    const file = path.join(cwd, 'mira.txt');
    fs.writeFileSync(file, 'You are Mira.');
    const d = deps();

    expect(await runPrompt(['push', 'mira.txt', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toContain('mira@1');

    expect(await runPrompt(['list', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toContain('mira');
    expect(out.at(-1)).toContain('@1');

    expect(await runPrompt(['get', 'mira@1', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toBe('You are Mira.');

    // a changed push bumps the version; a bare name resolves latest
    fs.writeFileSync(file, 'You are Mira v2.');
    await runPrompt(['push', 'mira.txt', '--url', base(daemon)], d);
    expect(await runPrompt(['get', 'mira', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toBe('You are Mira v2.');
  });

  it("push '-' reads stdin and requires --name", async () => {
    const daemon = await start();
    const d = deps();
    expect(await runPrompt(['push', '-', '--name', 'stdin-prompt', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toContain('stdin-prompt@1');
    expect(await runPrompt(['get', 'stdin-prompt', '--url', base(daemon)], d)).toBe(0);
    expect(out.at(-1)).toBe('from stdin');

    expect(await runPrompt(['push', '-', '--url', base(daemon)], d)).toBe(2);
  });

  it('push --labels/--variables are stored with the version; get --json shows them', async () => {
    const daemon = await start();
    fs.writeFileSync(path.join(cwd, 'p.txt'), 'text');
    const d = deps();
    await runPrompt(['push', 'p.txt', '--name', 'p', '--labels', 'prod,canary', '--variables', 'who', '--url', base(daemon)], d);
    expect(await runPrompt(['get', 'p', '--json', '--url', base(daemon)], d)).toBe(0);
    const row = JSON.parse(out.at(-1) ?? '{}') as { labels: string[]; variables: string[] };
    expect(row.labels).toEqual(['prod', 'canary']);
    expect(row.variables).toEqual(['who']);
  });

  it('exits 1 for a missing prompt and for an unreachable daemon', async () => {
    const daemon = await start();
    expect(await runPrompt(['get', 'nope', '--url', base(daemon)], deps())).toBe(1);
    expect(await runPrompt(['list', '--url', 'http://127.0.0.1:1'], deps())).toBe(1);
  });

  it('finds the daemon via --port or LOUSHO_OBSERVE_PORT when --url is absent', async () => {
    const daemon = await start();
    fs.writeFileSync(path.join(cwd, 'p.txt'), 'text');
    expect(await runPrompt(['push', 'p.txt', '--name', 'p', '--port', String(daemon.port)], deps())).toBe(0);
    const d = deps({ env: { LOUSHO_OBSERVE_PORT: String(daemon.port) } as NodeJS.ProcessEnv });
    expect(await runPrompt(['get', 'p'], d)).toBe(0);
    // an unparseable env port falls back to the default (7777) rather than crashing
    const urls: string[] = [];
    const bad = deps({
      env: { LOUSHO_OBSERVE_PORT: 'nope' } as NodeJS.ProcessEnv,
      fetchFn: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        throw new Error('fetch failed');
      }) as typeof fetch,
    });
    expect(await runPrompt(['list'], bad)).toBe(1);
    expect(urls[0]).toContain('127.0.0.1:7777');
  });

  it('usage errors exit 2; --help prints the help', async () => {
    expect(await runPrompt(['bogus'], deps())).toBe(2);
    expect(await runPrompt(['--help'], deps())).toBe(0);
    expect(out.at(-1)).toContain('lousho prompt');
  });
});
