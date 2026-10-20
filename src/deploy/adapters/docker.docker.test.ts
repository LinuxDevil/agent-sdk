/**
 * The image `lousho build --target=docker` scaffolds builds,
 * starts and serves /health and /chat on a real Docker daemon.
 *
 * Runs only through `npm run test:docker` (vitest.docker.config.ts); the Linux
 * Docker CI job (.github/workflows/docker.yml) runs it with
 * LOUSHO_DOCKER_TESTS=1, so it fails there rather than skipping when no daemon
 * answers. The fast, daemon-free DockerAdapter checks are in docker.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerAdapter } from './docker';
import { withBuildLock } from '../buildLock.testkit';
import { requireDocker } from '../../security/docker.testkit';

const hasDocker = await requireDocker();

function writeSpec(dir: string): string {
  const specPath = path.join(dir, 'agent.yaml');
  fs.writeFileSync(
    specPath,
    'name: docker-agent\nprompt: You are a containerized agent.\nprovider:\n  type: mock\n  model: mock-1\n'
  );
  return specPath;
}

/** `docker` with output captured; never throws (for diagnostics). */
function dockerOutput(args: string[]): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message;
  }
}

/** GET `url` until it answers (any status) or `attempts` seconds pass. */
async function poll(url: string, attempts: number): Promise<Response | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return undefined;
}

describe.skipIf(!hasDocker)('DockerAdapter image (real Docker daemon)', () => {
  it('the built image serves /health and /chat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-int-'));
    const outDir = path.join(dir, 'out');
    await DockerAdapter.scaffold(writeSpec(dir), outDir);
    await withBuildLock(() => DockerAdapter.build(outDir));

    const tag = `lousho-agent-test-${Date.now()}`;
    execFileSync('docker', ['build', '-t', tag, '.'], { cwd: outDir, stdio: 'inherit' });
    // The image binds 0.0.0.0 and this test calls /chat without a token: opt in to the open agent.
    const containerId = execFileSync('docker', ['run', '-d', '-p', '127.0.0.1::3000', '-e', 'LOUSHO_ALLOW_PUBLIC=1', tag], {
      encoding: 'utf8',
    }).trim();
    try {
      const mapping = execFileSync('docker', ['port', containerId, '3000'], { encoding: 'utf8' });
      const port = Number(mapping.trim().split('\n')[0].split(':').pop());
      const base = `http://127.0.0.1:${port}`;

      const health = await poll(`${base}/health`, 60);
      if (health?.status !== 200) {
        // Diagnostics for the CI log: why the server never answered.
        console.error(`docker port: ${mapping}`);
        console.error(`docker inspect State: ${dockerOutput(['inspect', '-f', '{{json .State}}', containerId])}`);
        console.error(`docker logs:\n${dockerOutput(['logs', containerId])}`);
      }
      expect(health?.status).toBe(200);

      const chat = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello container' }),
      });
      expect((await chat.json()).text).toBe('This is a mock response.');
    } finally {
      dockerOutput(['rm', '-f', containerId]);
      dockerOutput(['rmi', '-f', tag]);
    }
  }, 300_000);

  it('starts on a fresh named volume with LOUSHO_STORE=sqlite: and persists a session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-vol-'));
    const outDir = path.join(dir, 'out');
    await DockerAdapter.scaffold(writeSpec(dir), outDir);
    await withBuildLock(() => DockerAdapter.build(outDir));

    const stamp = Date.now();
    const tag = `lousho-agent-vol-test-${stamp}`;
    const volume = `lousho-vol-test-${stamp}`;
    execFileSync('docker', ['build', '-t', tag, '.'], { cwd: outDir, stdio: 'inherit' });
    execFileSync('docker', ['volume', 'create', volume]);
    const containerId = execFileSync(
      'docker',
      ['run', '-d', '-p', '127.0.0.1::3000', '-v', `${volume}:/app/data`, '-e', 'LOUSHO_STORE=sqlite:/app/data/lousho.db', '-e', 'LOUSHO_ALLOW_PUBLIC=1', tag],
      { encoding: 'utf8' }
    ).trim();
    try {
      const mapping = execFileSync('docker', ['port', containerId, '3000'], { encoding: 'utf8' });
      const base = `http://127.0.0.1:${Number(mapping.trim().split('\n')[0].split(':').pop())}`;
      const health = await poll(`${base}/health`, 60);
      if (health?.status !== 200) console.error(`docker logs:
${dockerOutput(['logs', containerId])}`);
      expect(health?.status).toBe(200);

      const chat = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello volume', sessionId: 'vol-1' }),
      });
      expect(chat.status).toBe(200);
      // The database file landed on the volume, written by the unprivileged user.
      const ls = execFileSync('docker', ['exec', containerId, 'ls', '-l', '/app/data'], { encoding: 'utf8' });
      expect(ls).toMatch(/lousho\.db/);
    } finally {
      dockerOutput(['rm', '-f', containerId]);
      dockerOutput(['rmi', '-f', tag]);
      dockerOutput(['volume', 'rm', '-f', volume]);
    }
  }, 300_000);
});
