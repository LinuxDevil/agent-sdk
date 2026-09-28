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

function startServer(outDir: string, extraArgs: string[] = []): Promise<{ child: ChildProcess; port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0', ...extraArgs], {
      cwd: outDir,
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-node-server-bad-'));
    const tsPath = path.join(dir, 'agent.ts');
    fs.writeFileSync(tsPath, 'export {}');
    expect(() => loadAgentSpecForDeploy(tsPath)).toThrow(/expected an AgentSpec .yaml\/.yml\/.json/);
    expect(() => loadAgentSpecForDeploy('')).toThrow(/--agent=<path> is required/);
    const bad = writeSpec(dir, { name: 'x', provider: { type: 'mock', model: 'm' } });
    expect(() => loadAgentSpecForDeploy(bad)).toThrow(/'prompt'/);
  });

  describe('scaffold + build + run (real subprocess)', () => {
    let outDir: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-node-server-'));
      const specPath = writeSpec(dir, SPEC);
      outDir = path.join(dir, 'out');
      await NodeServerAdapter.scaffold(specPath, outDir);
      await NodeServerAdapter.build(outDir);
    }, 120_000);

    it('scaffolds server.ts, agent.config.js and package.json, and builds dist/server.js', () => {
      const server = fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8');
      expect(server).toContain('AgentExecutor.execute(');
      expect(server).toContain("'127.0.0.1'");
      expect(server).toContain('MAX_BODY_BYTES = 1024 * 1024');
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
