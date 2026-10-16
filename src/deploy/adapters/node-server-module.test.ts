/**
 * The node-server (and docker) targets build a .ts agent module - the file
 * `lousho dev src/agent.ts` serves, as create-lousho-agent scaffolds it: a
 * default export holding createAgent() options. scaffold + tsup build + the
 * built dist/server.js as a real subprocess; only the LLM is the mock provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter, loadAgentSpecForDeploy } from './node-server';
import { withBuildLock } from '../buildLock.testkit';

const AGENT_TS = `import { createMockProvider, type CreateAgentConfig } from '@lousho/build-ai-agent';

const instructions: string = 'You are a deployed agent module.';
const config: CreateAgentConfig = { instructions, provider: createMockProvider({ name: 'mock', responses: ['module pong'] }) };
export default config;
`;

/**
 * Starts dist/server.js on a free port; resolves once it listens. `stop()`
 * resolves once the process has exited: Windows refuses to delete a directory
 * that is a running process's cwd, so afterAll's rmSync must wait for it.
 */
function startServer(outDir: string): Promise<{ stop: () => Promise<void>; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once('exit', () => done());
            child.kill();
          }),
        port: Number(match[1]),
      });
    });
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${output}`)));
  });
}

describe('NodeServerAdapter with an agent module', () => {
  let root: string;
  let outDir: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-agent-module-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'module-project', type: 'module' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'agent.ts'), AGENT_TS);
    outDir = path.join(root, 'out');
    await NodeServerAdapter.scaffold(path.join(root, 'src', 'agent.ts'), outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
  }, 120_000);
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('generates a server.ts that imports the module, and a package.json named after the project', () => {
    expect(fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8')).toContain('import * as agentModule from');
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'))).toMatchObject({ name: 'module-project', dependencies: {} });
  });

  it('the built server answers /chat with the module agent', async () => {
    const { stop, port } = await startServer(outDir);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { text: string }).text).toBe('module pong');
    } finally {
      await stop();
    }
  }, 30_000);

  it('a later spec build in the same out dir is not mistaken for the module', async () => {
    const spec = path.join(root, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ name: 's', prompt: 'p', provider: { type: 'mock', model: 'm' } }));
    await NodeServerAdapter.scaffold(spec, outDir);
    expect(fs.existsSync(path.join(outDir, 'agent-module.json'))).toBe(false);
  });

  it('targets that only build specs say which ones build a module', () => {
    expect(() => loadAgentSpecForDeploy(path.join(root, 'src', 'agent.ts'))).toThrow(/--target=node-server and --target=docker build an agent module/);
  });
});
