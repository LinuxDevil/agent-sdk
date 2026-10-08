/**
 * M3b: the cloudflare-worker target builds an agent directory (config,
 * instructions.md, TypeScript tools, skills); #298 adds `subagents/`,
 * `schedules/`, `channels/`, `memory/` and `projectInstructions`. A real
 * scaffold + tsup build of __fixtures__/worker-agent-dir and
 * __fixtures__/worker-agent-dir-full, then the built bundle's fetch() and
 * scheduled() handlers driven in-process with the registry's mock provider
 * (no network, no API key).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudflareWorkerAdapter, WORKER_SDK_EXPORTS, explainWorkerBuildError, findNodeBuiltinReferences } from './cloudflare';
import { withBuildLock } from '../buildLock.testkit';

const FIXTURE = path.join(__dirname, '__fixtures__', 'worker-agent-dir');
const FULL_FIXTURE = path.join(__dirname, '__fixtures__', 'worker-agent-dir-full');

type Handler = {
  fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response>;
  scheduled?: (controller: { cron: string; scheduledTime?: number }, env?: Record<string, unknown>, ctx?: { waitUntil(promise: Promise<unknown>): void }) => Promise<void>;
};

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

describe('cloudflare-worker target: agent directories (M3b, #298)', () => {
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
      expect(module).toMatch(/^import \* as mod\d+ from ".*worker-agent-dir\/tools\/echo\.ts";$/m);
      expect(module).toContain('{ file: "tools/echo.ts", module: mod0 }');
      expect(module).toContain('name: "worker-agent-dir"');
      expect(module).toContain('configFile: "agent.json"');
      expect(module).toContain('"model":"mock/test"');
      expect(module).toContain('instructions: "You are an agent directory deployed to a Cloudflare Worker.');
      expect(module).toContain('"name":"notes","description":"How to write short release notes"');
      expect(module).not.toContain('agentConfig');
    });

    it('writes a fetch-only worker.ts and a wrangler.toml without crons', () => {
      const worker = fs.readFileSync(path.join(outDir, 'worker.ts'), 'utf8');
      expect(worker).toContain('handleWorkerAgentDirRequest(request, env, agentDir');
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

  describe('scaffold + build of a directory with sub-agents, schedules, channels, memory and projectInstructions (#298)', () => {
    let outDir: string;
    let handler: Handler;

    beforeAll(async () => {
      outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-full-')), 'out');
      await CloudflareWorkerAdapter.scaffold(FULL_FIXTURE, outDir);
      await withBuildLock(() => CloudflareWorkerAdapter.build(outDir));
      handler = (await import(pathToFileURL(path.join(outDir, 'dist', 'worker.js')).href)).default as Handler;
    }, 180_000);

    it('embeds every folder and the project instructions in agent.module.ts', () => {
      const module = fs.readFileSync(path.join(outDir, 'agent.module.ts'), 'utf8');
      expect(module).toContain('{ file: "schedules/report.ts", module: ');
      expect(module).toContain('{ file: "channels/api.ts", module: ');
      expect(module).toContain('{ file: "memory/notes.ts", module: ');
      expect(module).toMatch(/subagents: \[\s*\{ name: "reviewer", dir: \{/);
      expect(module).toContain('projectInstructions: {"file":"AGENTS.md","content":"Always cite the handbook');
      // The sub-agent directory is embedded recursively, with its own instructions and config.
      expect(module).toContain('instructions: "You review drafts for tone."');
      expect(module).toContain('"description":"Reviews drafts"');
    });

    it('writes a worker.ts with a scheduled() export and a wrangler.toml [triggers] crons', () => {
      const worker = fs.readFileSync(path.join(outDir, 'worker.ts'), 'utf8');
      expect(worker).toContain('handleWorkerAgentDirScheduled(controller, env, ctx, agentDir)');
      expect(worker).toContain('export default { fetch, scheduled };');
      const toml = fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8');
      expect(toml).toContain('[triggers]');
      expect(toml).toContain('crons = ["0 9 * * MON"]');
    });

    it('passes the Node-builtin leak check', () => {
      const bundle = fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8');
      expect(findNodeBuiltinReferences(bundle)).toEqual([]);
    });

    it('delegates to the sub-agent through delegate_to_reviewer, with the AGENTS.md in the system prompt', async () => {
      const response = await handler.fetch(
        new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'use delegate_to_reviewer' }) }),
        {}
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        toolCalls: Array<{ function: { name: string } }>;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(result.toolCalls.map((call) => call.function.name)).toEqual(['delegate_to_reviewer']);
      const system = JSON.stringify(result.messages.find((m) => m.role === 'system')?.content);
      expect(system).toContain('## Project instructions (from AGENTS.md)');
      expect(system).toContain('Always cite the handbook in your answers.');
    });

    it('serves the channels/ channel under /channels/<name>', async () => {
      const response = await handler.fetch(
        new Request('http://worker/channels/api', { method: 'POST', body: JSON.stringify({ sessionKey: 'u1', input: 'ping' }) }),
        {}
      );
      expect(response?.status).toBe(200);
      expect((await response.json()) as { sessionId: string; text: string }).toMatchObject({ sessionId: expect.stringMatching(/^api_u1-/), text: 'This is a mock response.' });
    });

    it('runs the schedules/ cron from the scheduled() export, checkpointed as session schedule-<name>', async () => {
      const kv = new Map<string, string>();
      const binding = {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
      };
      const waited: Promise<unknown>[] = [];
      await handler.scheduled?.({ cron: '0 9 * * MON' }, { AGENT_CHECKPOINTS: binding }, { waitUntil: (promise) => waited.push(promise) });
      await Promise.all(waited);
      // A prompt schedule runs a turn under session `schedule-<name>`, checkpointed in the KV store.
      const checkpoint = kv.get('checkpoints/schedule-report');
      expect(JSON.stringify(checkpoint)).toContain('Write the report.');
      // A cron the directory does not schedule runs nothing.
      const keys = [...kv.keys()];
      await handler.scheduled?.({ cron: '0 10 * * MON' }, { AGENT_CHECKPOINTS: binding }, { waitUntil: (promise) => waited.push(promise) });
      expect([...kv.keys()]).toEqual(keys);
    });

    it('binds the memory/ slot\'s kvMemory() provider to the KV namespace and recalls from it', async () => {
      const kv = new Map<string, string>([['memory/notes#global', JSON.stringify([{ id: '1', text: 'likes tea', createdAt: '2024-01-01T00:00:00.000Z' }])]]);
      const binding = {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
      };
      const response = await handler.fetch(
        new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'use recall_notes' }) }),
        { AGENT_CHECKPOINTS: binding }
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as { toolCalls: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
      expect(result.toolCalls.map((call) => call.function.name)).toEqual(['recall_notes']);
      expect(JSON.stringify(result.messages.find((m) => m.role === 'tool')?.content)).toContain('likes tea');
    });
  });

  describe('refused at scaffold', () => {
    it('a sub-agent without a description, naming the directory', async () => {
      const dir = agentDir({
        ...MINIMAL,
        'subagents/reviewer/instructions.md': 'You review.\n',
        'subagents/reviewer/agent.json': '{}\n',
      });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toMatchObject({
        code: 'LOUSHO_AGENT_DIR_INVALID',
        message: expect.stringContaining("'description'"),
      });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toThrow(/sub-agent.*'reviewer'|'reviewer'.*sub-agent/);
    });

    it("a schedules/ file that does not default-export a defineSchedule() schedule", async () => {
      const dir = agentDir({ ...MINIMAL, 'schedules/report.ts': 'export default 42;\n' });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toMatchObject({
        code: 'LOUSHO_SCHEDULE_INVALID',
        message: expect.stringMatching(/schedules[\\/]report\.ts/),
      });
    });

    it('a cron Cloudflare would not fire (a timezone; crons are UTC)', async () => {
      const dir = agentDir({
        ...MINIMAL,
        'schedules/report.ts':
          "import { defineSchedule } from '@lousho/build-ai-agent';\n" +
          "export default defineSchedule({ cron: '0 9 * * MON', timezone: 'Europe/Berlin', prompt: 'Hi' });\n",
      });
      await expect(CloudflareWorkerAdapter.scaffold(dir, outDirFor(dir))).rejects.toMatchObject({
        code: 'LOUSHO_SCHEDULE_INVALID',
        message: expect.stringContaining('timezone'),
      });
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
