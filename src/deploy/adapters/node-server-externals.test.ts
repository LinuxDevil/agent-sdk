/**
 * LOU-P8.3: builds that bundle the SDK keep its optional peers external (so a
 * missing peer cannot fail the build), and the node server runs a spec's cron triggers.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { bundleExternals, optionalPeers } from '../bundle';
import { withBuildLock } from '../buildLock.testkit';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

/** Starts dist/server.js on a free port; resolves with its stdout once it reports its schedules. */
function startServer(outDir: string): Promise<{ stop: () => void; port: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout} ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)\s+lousho server: schedules: (.*)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve({ stop: () => child.kill(), port: Number(match[1]), stdout });
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${stdout} ${stderr}`)));
  });
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-p83-'));
}

describe('optional peers stay external in bundled builds', () => {
  it('are exactly the optional entries of package.json peerDependenciesMeta', () => {
    const expected = Object.keys(pkg.peerDependenciesMeta).filter((name) => pkg.peerDependenciesMeta[name].optional);
    expect(optionalPeers().sort()).toEqual(expected.sort());
    expect(optionalPeers()).toEqual(expect.arrayContaining(['dockerode', 'ollama-ai-provider-v2', '@ai-sdk/anthropic', '@modelcontextprotocol/sdk']));
  });

  it('noExternal inlines everything except a peer and its subpaths', () => {
    const [inline] = bundleExternals().noExternal;
    expect(inline.test('yaml')).toBe(true);
    expect(inline.test('ollama-ai-provider-v3')).toBe(true);
    expect(inline.test('@modelcontextprotocol/sdk/client/index.js')).toBe(false);
    expect(inline.test('ollama-ai-provider')).toBe(false);
  });

  it('a spec build with no peer next to it builds, keeps the peers as imports and serves /health', async () => {
    const dir = tmp();
    const spec = path.join(dir, 'agent.json');
    fs.writeFileSync(spec, JSON.stringify({ name: 'p83', prompt: 'p', provider: { type: 'mock', model: 'm' } }));
    const outDir = path.join(dir, 'out');
    await NodeServerAdapter.scaffold(spec, outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
    const built = fs.readFileSync(path.join(outDir, 'dist', 'server.js'), 'utf8');
    expect(built).toMatch(/import\("@modelcontextprotocol\/sdk\/client\/index\.js"\)/);
    const { stop, port } = await startServer(outDir);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      stop();
    }
  }, 120_000);
});

describe('spec cron triggers on the node server', () => {
  it('a spec with a cron trigger builds and the built server reports the schedule', async () => {
    const dir = tmp();
    const spec = path.join(dir, 'agent.json');
    fs.writeFileSync(
      spec,
      JSON.stringify({
        name: 'cron-agent',
        prompt: 'p',
        provider: { type: 'mock', model: 'm' },
        triggers: [{ type: 'cron', cron: '0 9 * * MON', input: 'Weekly report.', name: 'weekly', timezone: 'Europe/Paris' }],
      })
    );
    const outDir = path.join(dir, 'out');
    await NodeServerAdapter.scaffold(spec, outDir);
    expect(fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8')).toContain('schedules })');
    await withBuildLock(() => NodeServerAdapter.build(outDir));
    const { stop, stdout } = await startServer(outDir);
    stop();
    expect(stdout).toContain('schedules: weekly');
  }, 120_000);

  it('rejects an invalid cron trigger at build time', async () => {
    const dir = tmp();
    const spec = path.join(dir, 'agent.json');
    fs.writeFileSync(spec, JSON.stringify({ name: 'bad', prompt: 'p', provider: { type: 'mock', model: 'm' }, triggers: [{ type: 'cron', input: 'x' }] }));
    await expect(NodeServerAdapter.scaffold(spec, path.join(dir, 'out'))).rejects.toMatchObject({ code: 'LOUSHO_SCHEDULE_INVALID' });
  });
});
