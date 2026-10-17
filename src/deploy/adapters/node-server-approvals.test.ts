/**
 * `lousho build <agentDir> --target=node-server` with an auth.ts that exports
 * `authorizeSession` / `authorizeApproval`: the built server applies them, so
 * a manager can decide a user's paused claim and the user cannot approve
 * their own. Scaffold + tsup build + dist/server.js as a real subprocess;
 * only the LLM is the registry's mock provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { withBuildLock } from '../buildLock.testkit';

const AGENT_DIR = path.join(__dirname, '__fixtures__', 'node-server-approvals');

/** Starts dist/server.js on a free port; `stop()` resolves once the process has exited. */
function startServer(outDir: string): Promise<{ stop: () => Promise<void>; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout} ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      const stop = () =>
        new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          child.once('exit', () => done());
          child.kill();
        });
      resolve({ stop, port: Number(match[1]) });
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${stdout} ${stderr}`)));
  });
}

async function events(response: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

describe('a built agent directory with auth.ts access rules', () => {
  let outDir: string;
  let server: { stop: () => Promise<void>; port: number };

  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-approvals-out-'));
    await NodeServerAdapter.scaffold(AGENT_DIR, outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
    server = await startServer(outDir);
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  const call = (method: string, route: string, token: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  it("lets the manager decide alice's claim, and not alice herself", async () => {
    const paused = await events(await call('POST', '/chat', 'alice-token', { sessionId: 'alice-1', input: 'submit_expense: taxi, $340' }));
    const requested = paused.find((event) => event.type === 'approval.requested') as { approvalId: string } | undefined;
    expect(requested, JSON.stringify(paused)).toBeDefined();
    const decide = (token: string) => call('POST', `/chat/alice-1/approvals/${requested!.approvalId}`, token, { approved: true });

    const self = await decide('alice-token');
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_FORBIDDEN' });

    const manager = await decide('manager-token');
    expect(manager.status).toBe(200);
    expect((await events(manager)).at(-1)).toMatchObject({ type: 'run.done' });
  }, 30_000);

  it("applies authorizeSession: bob cannot read alice's session, the manager can", async () => {
    const bob = await call('GET', '/chat/alice-1', 'bob-token');
    expect(bob.status).toBe(403);
    expect(await bob.json()).toMatchObject({ code: 'LOUSHO_SESSION_FORBIDDEN' });
    expect((await call('GET', '/chat/alice-1', 'manager-token')).status).toBe(200);
    expect((await call('GET', '/chat/bob-1', 'bob-token')).status).toBe(200);
  });
});
