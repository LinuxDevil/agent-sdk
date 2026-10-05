/**
 * The coding-kit (H1): `lousho add coding-kit` installs the whole agent
 * directory, `loadAgentDir()` runs it and `lousho build --target=node-server`
 * deploys it - the same behavior as the inline harness in ./index.test.ts,
 * proven from the installed files instead of one createAgent() call.
 *
 * The scratch agent directory sits inside the repository so the kit's
 * `@lousho/build-ai-agent` imports resolve, and the directory is loaded
 * through the package itself (dist/) - the kit's files import the SDK by
 * name and a defineTool() tool is only recognized by the same copy of it.
 * Like defaultRegistry.test.ts this needs `npm run build` to have run.
 *
 * The mock provider serves the lead AND the explorer: the loader passes a
 * `provider` override down to sub-agent directories, so their calls share
 * one script (the explorer's responses sit between delegate_to_explorer and
 * the lead's next step).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { loadAgentDir } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { NodeServerAdapter } from '../../src/deploy/adapters/node-server';
import { withBuildLock } from '../../src/deploy/buildLock.testkit';
import { runAdd } from '../../src/cli/add';
import { FIXTURE, LIVE_MODEL } from './index';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'registry', 'dist', 'index.json');

let root: string;

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function add(args: string[]) {
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  stdin.end('');
  const out = sink();
  const err = sink();
  const code = await runAdd(args, { stdin, stdout: out.stream, stderr: err.stream, cwd: root, env: {} });
  return { code, out: out.text(), err: err.text() };
}

async function kitModule() {
  return (await import(pathToFileURL(path.join(root, 'tools', 'fs.ts')).href)) as {
    checkpoints: import('@lousho/build-ai-agent').WorkspaceCheckpoints;
  };
}

/** A provider that plays the lead's script and the explorer's, in call order. */
function scriptedHarness() {
  return mockModel([
    { toolCalls: [{ name: 'load_skill', args: { name: 'fix-failing-test' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'rm -rf node_modules' } }] },
    { toolCalls: [{ name: 'delegate_to_explorer', args: { task: 'Why does add(2, 3) not return 5?' } }] },
    // the explorer's run (same provider instance, via the inherited override)
    { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] },
    { text: 'math.js line 1: add() returns a - b. It should return a + b.' },
    // back to the lead
    { toolCalls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
    { text: 'Fixed add() in math.js (it subtracted); node --test now passes.' },
  ]);
}

const toolOutputs = (provider: ReturnType<typeof mockModel>): string =>
  provider.calls[provider.calls.length - 1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');

const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);

beforeEach(async () => {
  // Inside the repository so the kit's `@lousho/build-ai-agent` imports
  // resolve (the SDK is a workspace self-link), like defaultRegistry.test.ts.
  root = fs.mkdtempSync(path.join(REPO_ROOT, '.coding-kit-'));
  const result = await add(['coding-kit', '--registry', INDEX, '--dir', '.', '--yes', '--allow', 'exec,fs-write']);
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  for (const [file, content] of Object.entries(FIXTURE)) fs.writeFileSync(path.join(root, file), content);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('lousho add coding-kit', () => {
  it('writes the whole agent directory and records the kit manifest in the receipt', () => {
    for (const file of [
      'agent.json',
      'instructions.md',
      'instructions/openai.md',
      'instructions/anthropic.md',
      'hooks.ts',
      'approve.ts',
      'tools/fs.ts',
      'skills/fix-failing-test/SKILL.md',
      'subagents/explorer/agent.json',
      'subagents/explorer/instructions.md',
      'subagents/explorer/tools/read-only.ts',
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'lousho-registry.json'), 'utf8')) as {
      items: Record<string, { type: string; permissions: Record<string, unknown>; files: { path: string }[] }>;
    };
    const entry = receipt.items['coding-kit'];
    expect(entry.type).toBe('kit');
    expect(entry.permissions).toMatchObject({ exec: true, filesystem: 'write' });
    expect(entry.files.map((f) => f.path)).toContain('subagents/explorer/tools/read-only.ts');
  });
});

describe('the installed kit, loaded', () => {
  it('fixes the bug offline, refuses rm, delegates to the explorer and checkpoints the edit', async () => {
    const audit: string[] = [];
    const provider = scriptedHarness();
    const agent = await loadAgentDir(root, {
      provider,
      model: LIVE_MODEL,
      onPermissionDecision: (entry) => audit.push(`${entry.toolName}: ${entry.decision}${entry.rule?.reason ? ` (${entry.rule.reason})` : ''}`),
    });
    const { checkpoints } = await kitModule();

    const session = agent.session();
    const result = await session.send('The test in math.test.js fails. Fix it.');

    expect(result.finishReason).toBe('stop');
    expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toBe('exports.add = (a, b) => a + b;\n');
    expect(fs.readFileSync(path.join(root, 'math.test.js'), 'utf8')).toBe(FIXTURE['math.test.js']);
    expect(audit).toContain('shell: deny (Deleting files is not allowed)');
    expect(toolOutputs(provider)).toContain('a - b'); // the explorer's answer reached the lead
    expect(systemOf(provider.calls[0])).toContain('one tool at a time'); // instructions/openai.md

    const turns = await checkpoints.list({ sessionId: session.id });
    expect(turns.flatMap((turn) => turn.paths)).toEqual(['math.js']);
    await checkpoints.rewind(0, { sessionId: session.id });
    expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toBe(FIXTURE['math.js']);
  }, 60_000);

  it('never lets the agent edit a test file', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'write_file', args: { path: 'math.test.js', content: '// gone\n' } }] },
      { text: 'Gave up.' },
    ]);
    const agent = await loadAgentDir(root, { provider, model: LIVE_MODEL });

    await agent.send('Make the tests pass.');

    expect(fs.readFileSync(path.join(root, 'math.test.js'), 'utf8')).toBe(FIXTURE['math.test.js']);
  });

  it('denies the third identical tool call (loop guard hook)', async () => {
    const same = { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] };
    const provider = mockModel([same, same, same, { text: 'Stopped.' }]);
    const agent = await loadAgentDir(root, { provider, model: LIVE_MODEL });

    await agent.send('Read math.js three times.');

    expect(toolOutputs(provider)).toContain('You already called read_file with these arguments 2 times');
  });
});

describe('live', () => {
  it.skipIf(!process.env.OPENROUTER_API_KEY)('fixes the failing test for real on ' + LIVE_MODEL, async () => {
    const agent = await loadAgentDir(root, { onPermissionDecision: (entry) => console.log(`  [audit] ${entry.toolName}: ${entry.decision}`) });

    const result = await agent.send('The test in math.test.js fails. Fix it.');

    expect(result.finishReason).toBe('stop');
    expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toContain('a + b');
    expect(fs.readFileSync(path.join(root, 'math.test.js'), 'utf8')).toBe(FIXTURE['math.test.js']);
  }, 120_000);
});

describe('lousho build --target=node-server', () => {
  it('bundles the kit (hooks and approver included) and the built server answers /chat', async () => {
    // The kit's agent.json names a live model; for the build the same
    // options ride in an agent.ts whose provider is the SDK's mock.
    fs.rmSync(path.join(root, 'agent.json'));
    fs.writeFileSync(
      path.join(root, 'agent.ts'),
      `import { createMockProvider } from '@lousho/build-ai-agent';
export default {
  provider: createMockProvider({ name: 'mock', responses: ['Fixed add() in math.js; node --test now passes.'] }),
  maxSteps: 20,
  permissionMode: 'default',
  permissions: [
    { tool: 'shell', when: { command: '\\\\brm\\\\b' }, action: 'deny', reason: 'Deleting files is not allowed' },
    { tool: ['read_file', 'list_dir', 'glob', 'grep', 'load_skill', 'delegate_to_explorer', 'shell'], action: 'allow' },
    { tool: ['write_file', 'edit_file'], action: 'ask' },
  ],
  hooks: 'hooks.ts',
  approve: 'approve.ts',
  compaction: { thresholdPercent: 0.8 },
  limits: { maxCostUsd: 0.05 },
};
`
    );
    const outDir = path.join(os.tmpdir(), `lousho-coding-kit-out-${process.pid}`);
    try {
      await NodeServerAdapter.scaffold(root, outDir);
      await withBuildLock(() => NodeServerAdapter.build(outDir));

      // hooks.ts / approve.ts were compiled next to agent.js; agent.ts names them and the loader finds the .js sibling.
      for (const file of ['agent.js', 'hooks.js', 'approve.js', 'tools/fs.js', 'subagents/explorer/tools/read-only.js']) {
        expect(fs.existsSync(path.join(outDir, 'dist', 'agent', file)), file).toBe(true);
      }

      const { stop, port } = await new Promise<{ stop: () => Promise<void>; port: number }>((resolve, reject) => {
        const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}`)), 15_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          const match = /listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve({
              // Windows keeps outDir locked while the child lives - wait for the exit before rm -rf.
              stop: () =>
                new Promise<void>((done) => {
                  child.once('exit', () => done());
                  child.kill();
                  setTimeout(done, 5_000);
                }),
              port: Number(match[1]),
            });
          }
        });
        child.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${stdout}`)));
      });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'The test in math.test.js fails. Fix it.' }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { text: string }).text).toContain('Fixed add()');
      } finally {
        await stop();
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);
});
