/**
 * LOU-I2: real integration test for the node-server adapter - scaffold +
 * tsup build + start the actual built dist/server.js as a subprocess, then
 * hit GET /health and POST /chat over real HTTP. Nothing here is mocked
 * except the LLM itself (the spec's provider is the SDK's built-in 'mock').
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter, loadAgentSpecForDeploy } from './node-server';
import { getAdapter, registerBuiltInAdapters } from '../index';
import { withBuildLock } from '../buildLock.testkit';

function writeSpec(dir: string, spec: Record<string, unknown>, file = 'agent.json'): string {
  const specPath = path.join(dir, file);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

const SPEC = {
  name: 'deploy-test-agent',
  prompt: 'You are a helpful deployed test agent.',
  provider: { type: 'mock', model: 'mock-model-1' },
  tools: ['current-date'],
};

function startServer(outDir: string, extraArgs: string[] = [], env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0', ...extraArgs], {
      cwd: outDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout} ${stderr}`)), 15_000);
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/([^:]+):(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, host: match[1], port: Number(match[2]) });
      }
    });
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}): ${stdout} ${stderr}`));
    });
  });
}

describe('NodeServerAdapter', () => {
  it("is registered as 'node-server' by registerBuiltInAdapters() and describes itself as 'node dist/server.js'", () => {
    registerBuiltInAdapters();
    expect(getAdapter('node-server')).toBe(NodeServerAdapter);
    expect(NodeServerAdapter.describe('/anywhere')).toBe('node dist/server.js');
  });

  it('rejects non-spec agent configs and invalid specs with clear errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-bad-'));
    const tsPath = path.join(dir, 'agent.ts');
    fs.writeFileSync(tsPath, 'export {}');
    expect(() => loadAgentSpecForDeploy(tsPath)).toThrow(/expected an AgentSpec .yaml\/.yml\/.json/);
    expect(() => loadAgentSpecForDeploy('')).toThrow(/--agent=<path> is required/);
    const bad = writeSpec(dir, { name: 'x', provider: { type: 'mock', model: 'm' } });
    expect(() => loadAgentSpecForDeploy(bad)).toThrow(/'prompt'/);
  });

  it('bakes the auth.token build option into the generated server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-auth-'));
    const outDir = path.join(dir, 'out');
    await NodeServerAdapter.scaffold(writeSpec(dir, SPEC), outDir, { auth: { token: 'build-time-token' } });
    expect(fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8')).toContain('createDeployedServer(agent, { ...{"auth":{"token":"build-time-token"}}, schedules })');
  });

  describe('scaffold + build + run (real subprocess)', () => {
    let outDir: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-'));
      const specPath = writeSpec(dir, SPEC);
      outDir = path.join(dir, 'out');
      await NodeServerAdapter.scaffold(specPath, outDir);
      await withBuildLock(() => NodeServerAdapter.build(outDir));
    }, 120_000);

    it('scaffolds server.ts, agent.config.js and package.json, and builds dist/server.js', () => {
      const server = fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8');
      expect(server).toContain('createDeployedServer(agent, { ...{}, schedules })');
      expect(server).toContain("'127.0.0.1'");
      expect(fs.readFileSync(path.join(outDir, 'agent.config.js'), 'utf8')).toContain('deploy-test-agent');
      expect(JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8')).scripts.start).toBe(
        'node dist/server.js'
      );
      expect(fs.statSync(path.join(outDir, 'dist', 'server.js')).size).toBeGreaterThan(0);
    });

    it('the built server answers GET /health and POST /chat with a real agent response, bound to 127.0.0.1 by default', async () => {
      const { child, host, port } = await startServer(outDir);
      try {
        expect(host).toBe('127.0.0.1');
        const base = `http://127.0.0.1:${port}`;

        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);
        expect(await health.text()).toBe('ok');

        const chat = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'hello deployed agent' }),
        });
        expect(chat.status).toBe(200);
        const json = await chat.json();
        expect(json.text).toBe('This is a mock response.');
        expect(json.finishReason).toBeDefined();

        const bad = await fetch(`${base}/chat`, { method: 'POST', body: '{}' });
        expect(bad.status).toBe(400);

        const oversized = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024) }),
        });
        expect(oversized.status).toBe(413);
      } finally {
        child.kill();
      }
    }, 30_000);

    it('serves sessions over SSE, and keeps them in the sqlite file LOUSHO_STORE names across restarts', async () => {
      const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-db-')), 'agent.db');
      const env = { LOUSHO_STORE: `sqlite:${db}` };
      const send = (base: string, sessionId: string, input: string) =>
        fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, input }),
        });

      const first = await startServer(outDir, [], env);
      try {
        const res = await send(`http://127.0.0.1:${first.port}`, 'persisted', 'hello');
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const body = await res.text();
        expect(body).toContain('This is a mock response.');
        expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
      } finally {
        first.child.kill();
      }

      const second = await startServer(outDir, [], env);
      try {
        const base = `http://127.0.0.1:${second.port}`;
        await (await send(base, 'persisted', 'again')).text();
        const saved = await (await fetch(`${base}/chat/persisted`)).json();
        expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      } finally {
        second.child.kill();
      }
    }, 60_000);

    it('requires LOUSHO_API_TOKEN as a bearer token on every route but /health, and warns when public without one', async () => {
      const { child, port } = await startServer(outDir, [], { LOUSHO_API_TOKEN: 'deploy-secret' });
      try {
        const base = `http://127.0.0.1:${port}`;
        expect((await fetch(`${base}/health`)).status).toBe(200);
        const denied = await fetch(`${base}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
        expect(denied.status).toBe(401);
        const ok = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { Authorization: 'Bearer deploy-secret' },
          body: JSON.stringify({ message: 'hi' }),
        });
        expect((await ok.json()).text).toBe('This is a mock response.');
      } finally {
        child.kill();
      }

      const open = spawn(process.execPath, ['dist/server.js', '--port=0', '--host=0.0.0.0'], {
        cwd: outDir,
        env: { ...process.env, LOUSHO_API_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        const warning = await new Promise<string>((resolve) => {
          let err = '';
          open.stderr!.on('data', (chunk) => {
            err += chunk;
            if (err.includes('no LOUSHO_API_TOKEN')) resolve(err);
          });
        });
        expect(warning).toContain('anyone who can reach 0.0.0.0');
      } finally {
        open.kill();
      }
    }, 60_000);

    it('binds to an explicitly opted-in host via --host', async () => {
      const { child, host } = await startServer(outDir, ['--host=0.0.0.0']);
      try {
        expect(host).toBe('0.0.0.0');
      } finally {
        child.kill();
      }
    }, 30_000);
  });
});
