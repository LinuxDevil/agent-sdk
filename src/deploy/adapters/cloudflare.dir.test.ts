/**
 * M3b: the cloudflare-worker target builds an agent directory (config,
 * instructions.md, TypeScript tools, skills). A real scaffold + tsup build of
 * __fixtures__/worker-agent-dir, then the built bundle's fetch() handler driven
 * in-process with the registry's mock provider (no network, no API key).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudflareWorkerAdapter, WORKER_SDK_EXPORTS, explainWorkerBuildError, findNodeBuiltinReferences } from './cloudflare';
import { withBuildLock } from '../buildLock.testkit';

const FIXTURE = path.join(__dirname, '__fixtures__', 'worker-agent-dir');

type Handler = { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };

/** A fresh agent directory in the OS temp dir with `files` (path -> content). */
function agentDir(files: Record<string, string>): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-dir-')), 'my-agent');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function outDirFor(dir: string): string {
  return path.join(path.dirname(dir), 'out');
}

const MINIMAL = { 'instructions.md': 'Be brief.\n', 'agent.json': '{ "model": "mock/test" }\n' };

describe('cloudflare-worker target: agent directories (M3b)', () => {
  describe('scaffold + build of the fixture', () => {
    let outDir: string;
    let handler: Handler;

    beforeAll(async () => {
      outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-dir-')), 'out');
      await CloudflareWorkerAdapter.scaffold(FIXTURE, outDir);
      await withBuildLock(() => CloudflareWorkerAdapter.build(outDir));
      handler = (await import(pathToFileURL(path.join(outDir, 'dist', 'worker.js')).href)).default as Handler;
    }, 180_000);

    it('writes agent.module.ts with static tool imports and the directory embedded as JSON', () => {
      const module = fs.readFileSync(path.join(outDir, 'agent.module.ts'), 'utf8');
      expect(module).toMatch(/^import \* as tool0 from ".*worker-agent-dir\/tools\/echo\.ts";$/m);
      expect(module).toContain('{ file: "tools/echo.ts", module: tool0 }');
      expect(module).toContain('name: "worker-agent-dir"');
      expect(module).toContain('configFile: "agent.json"');
      expect(module).toContain('"model":"mock/test"');
      expect(module).toContain('instructions: "You are an agent directory deployed to a Cloudflare Worker.');
      expect(module).toContain('"name":"notes","description":"How to write short release notes"');
      expect(module).not.toContain('agentConfig');
    });

    it('writes a fetch-only worker.ts and a wrangler.toml without crons', () => {
      const worker = fs.readFileSync(path.join(outDir, 'worker.ts'), 'utf8');
      expect(worker).toContain('handleWorkerAgentDirRequest(request, env, agentDir)');
      expect(worker).toContain('prepareWorkerAgentDir(agentDir);');
      expect(worker).not.toContain('scheduled');
      const toml = fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8');
      expect(toml).toContain('name = "worker-agent-dir"');
      expect(toml).toContain('main = "dist/worker.js"');
      expect(toml).not.toContain('[triggers]');
    });

    it('passes the Node-builtin leak check', () => {
      const bundle = fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8');
      expect(findNodeBuiltinReferences(bundle)).toEqual([]);
      expect(bundle).toContain('Echoes its input back');
    });

    it("runs a /chat turn that calls the directory's echo tool, with the skill in the system prompt", async () => {
      const response = await handler.fetch(
        new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'Please echo this' }) }),
        {}
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        text: string;
        toolCalls: Array<{ function: { name: string } }>;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(result.toolCalls.map((call) => call.function.name)).toEqual(['echo']);
      const toolMessage = result.messages.find((m) => m.role === 'tool');
      expect(JSON.stringify(toolMessage?.content)).toContain('echo: mock input');
      const system = JSON.stringify(result.messages.find((m) => m.role === 'system')?.content);
      expect(system).toContain('You are an agent directory deployed to a Cloudflare Worker.');
      expect(system).toContain('## Available skills');
      expect(system).toContain('- notes: How to write short release notes');
      expect(result.text).toBe('This is a mock response.');
    });

    it('serves sessions over SSE with bearer auth, like a spec Worker', async () => {
      const env = { LOUSHO_API_TOKEN: 'tok' };
      const post = (headers: Record<string, string>) =>
        handler.fetch(new Request('http://worker/chat', { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', input: 'hi' }) }), env);
      expect((await post({})).status).toBe(401);
      const raw = await (await post({ Authorization: 'Bearer tok' })).text();
      expect(raw).toContain('"type":"run.done"');
      expect((await handler.fetch(new Request('http://worker/health'), env)).status).toBe(200);
    });
  });

  describe('refused at scaffold', () => {
    it.each(['subagents', 'schedules', 'channels', 'memory'])("a directory with a '%s/' folder", async (folder) => {
      const dir = agentDir({ ...MINIMAL, [`${folder}/x/instructions.md`]: 'x\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toMatchObject({
        code: 'LOUSHO_DEPLOY_FAILED',
        message: expect.stringContaining(`has a '${folder}/' folder`),
      });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toThrow('--target=node-server');
    });

    it("'projectInstructions' in the config", async () => {
      const dir = agentDir({ ...MINIMAL, 'agent.json': '{ "model": "mock/test", "projectInstructions": true }\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toThrow(/agent\.json sets 'projectInstructions'/);
    });

    it('a model of a provider the Worker does not have', async () => {
      const dir = agentDir({ ...MINIMAL, 'agent.json': '{ "model": "ollama/llama3" }\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toMatchObject({
        code: 'LOUSHO_DEPLOY_FAILED',
        message: expect.stringContaining("uses provider 'ollama'"),
      });
    });

    it('a JSON config that sets no model', async () => {
      const dir = agentDir({ ...MINIMAL, 'agent.json': '{ "maxSteps": 2 }\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toThrow(/sets no model/);
    });

    it('a folder that is not an agent directory', async () => {
      const dir = agentDir({ 'README.md': 'hi\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toThrow(/not an agent directory/);
    });
  });

  describe('refused at build', () => {
    it('a tool that imports a Node builtin, naming the file', async () => {
      const dir = agentDir({
        ...MINIMAL,
        'tools/files.ts': "import { readFileSync } from 'node:fs';\nexport const read = (file: string) => readFileSync(file, 'utf8');\n",
      });
      const outDir = outDirFor(dir);
      await CloudflareWorkerAdapter.scaffold(dir, outDir);
      const error = await withBuildLock(() => CloudflareWorkerAdapter.build(outDir)).then(
        () => undefined,
        (e: Error & { code?: string }) => e
      );
      expect(error?.code).toBe('LOUSHO_DEPLOY_FAILED');
      expect(error?.message).toContain('Node builtins leaked');
      expect(error?.message).toMatch(/"node:fs" imported by .*my-agent[\\/]tools[\\/]files\.ts/);
      expect(error?.message).toContain('--target=node-server');
    }, 180_000);
  });

  it("explains esbuild's missing-export error for an SDK name a Worker bundle does not offer", () => {
    // The real message of a tool importing `fileStore` (a failing tsup build is not run here: tsup reports
    // build errors to a worker thread's parentPort, which vitest's thread pool treats as an unhandled error).
    const esbuild = new Error(
      'Build failed with 1 error:\n/tmp/my-agent/tools/store.ts:1:9: ERROR: No matching export in "src/deploy/workerSdk.ts" for import "fileStore"'
    );
    const explained = explainWorkerBuildError(esbuild) as Error & { code?: string; cause?: unknown };
    expect(explained.code).toBe('LOUSHO_DEPLOY_FAILED');
    expect(explained.message).toContain('for import "fileStore"');
    expect(explained.message).toContain(`from '@lousho/build-ai-agent': ${WORKER_SDK_EXPORTS.join(', ')}`);
    expect(explained.cause).toBe(esbuild);
    const other = new Error('Build failed with 1 error: Could not resolve "x"');
    expect(explainWorkerBuildError(other)).toBe(other);
  });

  it('WORKER_SDK_EXPORTS lists exactly the exports of the Worker SDK entry', async () => {
    const workerSdk = await import('../workerSdk');
    expect([...WORKER_SDK_EXPORTS].sort()).toEqual(Object.keys(workerSdk).sort());
  });
});
