/**
 * LOU-P8.2: the node-server (and docker) targets deploy an agent directory:
 * scaffold + tsup build + the built dist/server.js as a real subprocess that
 * mounts the directory's channels and reports its schedules. Only the LLM is
 * the SDK's mock provider.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { DockerAdapter } from './docker';
import { parseBuildArgs } from '../../cli/build';
import { withBuildLock } from '../buildLock.testkit';

const FILES: Record<string, string> = {
  'instructions.md': 'You are a deployed agent directory.\n',
  'agent.ts': `import { createMockProvider } from '@lousho/build-ai-agent';
export default { provider: createMockProvider({ name: 'mock', responses: ['pong'] }) };
`,
  'schedules/daily.ts': `import { defineSchedule } from '@lousho/build-ai-agent';
export default defineSchedule({ cron: '0 9 * * *', prompt: 'Good morning' });
`,
  'auth.ts': `import { apiToken, basic } from '@lousho/build-ai-agent/auth';
export default [basic({ users: { ops: 'pw' } }), apiToken('dir-token', { id: 'ci' })];
`,
  'channels/echo.ts': `import { defineChannel } from '@lousho/build-ai-agent';
export default defineChannel({
  name: 'echo',
  async parse(req) { return { sessionKey: 'k', input: req.text, replyTo: null }; },
  async reply({ text, respond }) { respond?.(200, { reply: text }); },
});
`,
};

function writeAgentDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-agent-dir-')), 'my-agent');
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** Starts dist/server.js on a free port; resolves with its stdout once it listens. */
function startServer(outDir: string): Promise<{ stop: () => void; port: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout} ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)\s+lousho server: schedules/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve({ stop: () => child.kill(), port: Number(match[1]), stdout });
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${stdout} ${stderr}`)));
  });
}

describe('NodeServerAdapter with an agent directory', () => {
  let agentDir: string;
  let outDir: string;

  beforeAll(async () => {
    agentDir = writeAgentDir();
    outDir = path.join(path.dirname(agentDir), 'out');
    await NodeServerAdapter.scaffold(agentDir, outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
  }, 120_000);

  it('generates an entry that resolves the directory and passes its schedules and channels to the server', () => {
    const server = fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8');
    expect(server).toContain('resolveAgentDir(');
    expect(server).toContain('createDeployedServer(agent, { ...{}, ...(resolved.auth ? { auth: resolved.auth } : {}), schedules: resolved.schedules, channels: resolved.channels })');
    expect(fs.existsSync(path.join(outDir, 'agent.config.js'))).toBe(false);
  });

  it('bundles the code files to dist/agent and copies the rest', () => {
    for (const file of ['agent.js', 'auth.js', 'schedules/daily.js', 'channels/echo.js', 'instructions.md']) {
      expect(fs.existsSync(path.join(outDir, 'dist', 'agent', file)), file).toBe(true);
    }
    expect(fs.existsSync(path.join(outDir, 'dist', 'agent', 'channels', 'echo.ts'))).toBe(false);
  });

  it('the built server mounts the channel, answers it and reports the schedule', async () => {
    const { stop, port, stdout } = await startServer(outDir);
    try {
      expect(stdout).toContain('schedules: daily; channels: echo');
      const hook = await fetch(`http://127.0.0.1:${port}/channels/echo`, { method: 'POST', body: 'ping' });
      expect(hook.status).toBe(200);
      expect(((await hook.json()) as { reply: string }).reply.trim()).toBe('pong');
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      // N10a: auth.ts guards the chat routes (the channel above was answered without it).
      const chat = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/chat/s1`, { headers }).then((res) => res.status);
      expect(await chat({})).toBe(401);
      expect(await chat({ Authorization: 'Bearer wrong' })).toBe(401);
      expect(await chat({ Authorization: 'Bearer dir-token' })).toBe(200);
      // any authenticated caller may use the session (ownership is authorizeSession's job)
      expect(await chat({ Authorization: `Basic ${btoa('ops:pw')}` })).toBe(200);
    } finally {
      stop();
    }
  }, 30_000);

  it('a later spec build in the same out dir is not mistaken for the directory', async () => {
    const spec = path.join(path.dirname(agentDir), 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ name: 's', prompt: 'p', provider: { type: 'mock', model: 'm' } }));
    await NodeServerAdapter.scaffold(spec, outDir);
    expect(fs.existsSync(path.join(outDir, 'agent-dir.json'))).toBe(false);
  });

  it('docker scaffolds the same entry and Dockerfile', async () => {
    const dockerOut = path.join(path.dirname(agentDir), 'docker-out');
    await DockerAdapter.scaffold(agentDir, dockerOut);
    expect(fs.readFileSync(path.join(dockerOut, 'server.ts'), 'utf8')).toContain('resolveAgentDir(');
    expect(fs.readFileSync(path.join(dockerOut, 'Dockerfile'), 'utf8')).toContain('COPY dist/ ./dist/');
  });

  it('rejects a directory that is not an agent directory', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-not-agent-'));
    await expect(NodeServerAdapter.scaffold(empty, path.join(empty, 'out'))).rejects.toThrow(/not an agent directory/);
  });
});

describe('lousho build <path>', () => {
  it('takes the agent as a positional argument', () => {
    expect(parseBuildArgs(['./my-agent', '--target', 'node-server'])).toMatchObject({ agent: './my-agent', target: 'node-server' });
    expect(parseBuildArgs(['--agent=./a', '--target=docker'])).toMatchObject({ agent: './a' });
  });
});
