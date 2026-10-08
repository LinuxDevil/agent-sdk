/**
 * coding-pi (the production harness): `lousho add coding-pi` installs the
 * coding-kit shape with two differences - the lead runs on the Pi provider
 * (`pi/openrouter/openai/gpt-4o-mini`) and `subagents/coder/` declares
 * `engine: 'pi'`, a Pi coding-agent sub-agent the lead reaches through the
 * `task` tool. The coder's own permission rules gate its internal calls.
 *
 * Offline runs script the lead with mockModel and inject pi-ai's faux
 * provider into the dir-declared sub-agent via `loadAgentDir`'s
 * `piAgent` override; the Pi session's tools edit the installed workspace
 * for real. The live run is the full production stack: Pi provider lead
 * delegating to a real Pi coding agent over OpenRouter.
 *
 * Like kit.test.ts this needs `npm run build` to have run (the kit's files
 * import `@lousho/build-ai-agent` by name and the loader goes through dist).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadAgentDir } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { runAdd } from '../../src/cli/add';
import { FIXTURE } from './index';

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

function testsPass(dir: string): boolean {
  try {
    execFileSync('node', ['--test'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** pi-ai faux script: fix the fixture's broken add(), verify with node --test. */
const fixer: FauxResponseStep = (context) => {
  const last = context.messages.at(-1);
  if (last?.role === 'toolResult') {
    if (last.toolName === 'edit') {
      return last.isError
        ? fauxAssistantMessage('The edit was refused; math.js is unchanged.')
        : fauxAssistantMessage(fauxToolCall('bash', { command: 'node --test' }));
    }
    return fauxAssistantMessage('Fixed add() in math.js; node --test passes.');
  }
  return fauxAssistantMessage(
    fauxToolCall('edit', { path: 'math.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] })
  );
};

const repeat = (step: FauxResponseStep, count = 8): FauxResponseStep[] => Array.from({ length: count }, () => step);

/** A faux pi-coding-agent runtime for `loadAgentDir`'s piAgent override. */
async function fauxPi(stateDir: string) {
  const runtime = await ModelRuntime.create({
    authPath: path.join(stateDir, 'auth.json'),
    modelsStorePath: path.join(stateDir, 'models.json'),
    refreshOnCreate: false,
  });
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  return { runtime, faux, model: runtime.getModel('faux', 'faux-1')! };
}

beforeEach(async () => {
  // Inside the repository so the kit's `@lousho/build-ai-agent` imports resolve.
  root = fs.mkdtempSync(path.join(REPO_ROOT, '.coding-pi-'));
  const result = await add(['coding-pi', '--registry', INDEX, '--dir', '.', '--yes', '--allow', 'exec,fs-write,network,env']);
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  for (const [file, content] of Object.entries(FIXTURE)) fs.writeFileSync(path.join(root, file), content);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('lousho add coding-pi', () => {
  it('writes the whole agent directory including the pi coder sub-agent', () => {
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
      'subagents/coder/agent.json',
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    const coder = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'coder', 'agent.json'), 'utf8')) as {
      engine: string;
      model: string;
    };
    expect(coder.engine).toBe('pi');
    expect(coder.model).toBe('pi/openrouter/openai/gpt-4o-mini');

    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'lousho-registry.json'), 'utf8')) as {
      items: Record<string, { type: string; permissions: Record<string, unknown>; files: { path: string }[] }>;
    };
    const entry = receipt.items['coding-pi'];
    expect(entry.type).toBe('kit');
    expect(entry.permissions).toMatchObject({ exec: true, filesystem: 'write', network: ['api.openrouter.ai'], env: ['OPENROUTER_API_KEY'] });
    expect(entry.files.map((f) => f.path)).toContain('subagents/coder/agent.json');
  });
});

describe('the installed kit, loaded', () => {
  it('puts the pi coder in the subagents map and keeps the explorer a delegate tool', async () => {
    const { resolveAgentDir } = await import('@lousho/build-ai-agent');
    const { config, manifest } = await resolveAgentDir(root, { provider: mockModel(['x']) });

    expect(manifest.subagents).toEqual(['coder', 'explorer']);
    const toolNames = (config.tools as unknown as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain('delegate_to_explorer');
    expect(toolNames).not.toContain('delegate_to_coder');
    const coder = (config.subagents as Record<string, unknown>).coder as { run?: unknown; description?: string };
    expect(typeof coder.run).toBe('function'); // a RemoteSubagent, not a delegate tool
    expect(coder.description).toContain('code change');
  });

  it('runs end to end offline: mock lead -> task -> pi coder edits math.js so node --test passes', async () => {
    const piState = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-coding-pi-'));
    try {
      const { runtime, faux, model } = await fauxPi(piState);
      faux.setResponses(repeat(fixer));
      const agent = await loadAgentDir(root, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Fix math.js so the test passes.', description: 'fix add()' } }] },
          { text: 'The coder fixed math.js.' },
        ]),
        piAgent: { modelRuntime: runtime, model, agentDir: piState, sessionDir: path.join(piState, 'sessions') },
      });

      const result = await agent.send('The test in math.test.js fails. Fix it.');

      expect(result.text).toBe('The coder fixed math.js.');
      expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toBe('exports.add = (a, b) => a + b;\n');
      expect(fs.readFileSync(path.join(root, 'math.test.js'), 'utf8')).toBe(FIXTURE['math.test.js']);
      expect(testsPass(root)).toBe(true);
    } finally {
      fs.rmSync(piState, { recursive: true, force: true });
    }
  }, 60_000);

  it("the pi coder's own permission rules deny destructive commands", async () => {
    const piState = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-coding-pi-'));
    try {
      const { runtime, faux, model } = await fauxPi(piState);
      const deleter: FauxResponseStep = (context) => {
        const last = context.messages.at(-1);
        if (last?.role === 'toolResult') return fauxAssistantMessage('The delete was refused.');
        return fauxAssistantMessage(fauxToolCall('bash', { command: 'rm -f math.js' }));
      };
      faux.setResponses(repeat(deleter));
      const agent = await loadAgentDir(root, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Clean up math.js.', description: 'cleanup' } }] },
          { text: 'done' },
        ]),
        piAgent: { modelRuntime: runtime, model, agentDir: piState, sessionDir: path.join(piState, 'sessions') },
      });

      await agent.send('Clean up.');
      expect(fs.existsSync(path.join(root, 'math.js'))).toBe(true);
    } finally {
      fs.rmSync(piState, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('live', () => {
  it.skipIf(!process.env.OPENROUTER_API_KEY)('runs the full pi stack on OpenRouter and fixes the test', async () => {
    const agent = await loadAgentDir(root);

    const result = await agent.send('The test in math.test.js fails. Fix it. You may delegate implementation to the coder sub-agent.');

    expect(result.finishReason).toBe('stop');
    expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toContain('a + b');
    expect(fs.readFileSync(path.join(root, 'math.test.js'), 'utf8')).toBe(FIXTURE['math.test.js']);
    expect(testsPass(root)).toBe(true);
  }, 120_000);
});
