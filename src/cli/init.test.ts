import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import prompts from 'prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitEnvironment } from './init';

interface Harness {
  environment: InitEnvironment;
  out: string[];
  err: string[];
  commands: string[];
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-init-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function harness(overrides: Partial<InitEnvironment> = {}, execCode = 0): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const commands: string[] = [];
  const environment: InitEnvironment = {
    env: {},
    cwd: root,
    interactive: false,
    sdk: { version: '1.0.0-alpha.8', peerDependencies: { ai: '^4.3.19', zod: '^3.25.76' } },
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    exec: async (command, args) => {
      commands.push([command, ...args].join(' '));
      return execCode;
    },
    ...overrides,
  };
  return { environment, out, err, commands };
}

const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('runInit --yes', () => {
  it('scaffolds the minimal openai project with defaults, installs and git-inits', async () => {
    const h = harness();
    expect(await runInit(['my-agent', '--yes'], h.environment)).toBe(0);

    expect(fs.existsSync(path.join(root, 'my-agent', 'src', 'agent.ts'))).toBe(true);
    expect(JSON.parse(read('my-agent', 'package.json'))).toMatchObject({ name: 'my-agent', type: 'module' });
    expect(read('my-agent', '.env.example')).toContain('OPENAI_API_KEY=');
    expect(h.commands).toEqual(['git init', 'npm install']);
    const text = h.out.join('');
    expect(text).toContain('Next steps:');
    expect(text).toContain('cd my-agent');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('npm run dev');
  });

  it('uses my-agent as the directory when none is given', async () => {
    expect(await runInit(['--yes', '--no-install', '--no-git'], harness().environment)).toBe(0);
    expect(fs.existsSync(path.join(root, 'my-agent', 'package.json'))).toBe(true);
  });

  it('detects the provider from the API key in the environment', async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await runInit(['demo', '--yes', '--no-install', '--no-git'], h.environment);
    expect(read('demo', 'src', 'agent.ts')).toContain("model: 'anthropic/");
    expect(read('demo', '.env.example')).toContain('ANTHROPIC_API_KEY=');
  });

  it('lets --provider and --template override detection and defaults', async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await runInit(['demo', '--yes', '--provider', 'ollama', '--template', 'yaml', '--no-install', '--no-git'], h.environment);
    expect(read('demo', 'agent.yaml')).toContain('type: ollama');
    expect(fs.existsSync(path.join(root, 'demo', 'src', 'agent.ts'))).toBe(false);
  });

  it('uses the package manager from npm_config_user_agent, or --package-manager', async () => {
    const detected = harness({ env: { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.19.0 linux x64' } });
    await runInit(['a', '--yes', '--no-git'], detected.environment);
    expect(detected.commands).toEqual(['pnpm install']);
    expect(detected.out.join('')).toContain('pnpm run dev');

    const forced = harness({ env: { npm_config_user_agent: 'pnpm/9.1.0' } });
    await runInit(['b', '--yes', '--no-git', '--package-manager', 'yarn'], forced.environment);
    expect(forced.commands).toEqual(['yarn install']);
  });

  it('skips install and git on request and then lists the install step', async () => {
    const h = harness();
    await runInit(['demo', '--yes', '--no-install', '--no-git'], h.environment);
    expect(h.commands).toEqual([]);
    expect(h.out.join('')).toContain('npm install');
  });

  it('writes a caret range of the SDK version, or a tarball with --sdk-path', async () => {
    await runInit(['plain', '--yes', '--no-install', '--no-git'], harness().environment);
    expect(JSON.parse(read('plain', 'package.json')).dependencies['@lousho/build-ai-agent']).toBe('^1.0.0-alpha.8');

    const tarball = path.join(root, 'sdk-9.9.9.tgz');
    fs.writeFileSync(tarball, 'tgz');
    await runInit(['local', '--yes', '--no-install', '--no-git', '--sdk-path', tarball], harness().environment);
    expect(JSON.parse(read('local', 'package.json')).dependencies['@lousho/build-ai-agent']).toBe('file:./sdk-9.9.9.tgz');
    expect(fs.existsSync(path.join(root, 'local', 'sdk-9.9.9.tgz'))).toBe(true);
  });

  it('derives a valid package name from the directory', async () => {
    await runInit(['My Cool_Agent!', '--yes', '--no-install', '--no-git'], harness().environment);
    expect(JSON.parse(read('My Cool_Agent!', 'package.json')).name).toBe('my-cool_agent');
  });
});

describe('runInit guards', () => {
  it('refuses a non-empty directory, naming it and the --force escape hatch, and writes nothing', async () => {
    fs.mkdirSync(path.join(root, 'taken'));
    fs.writeFileSync(path.join(root, 'taken', 'notes.txt'), 'mine');
    const h = harness();

    expect(await runInit(['taken', '--yes'], h.environment)).toBe(1);

    expect(h.err.join('')).toMatch(/taken' is not empty.*--force/);
    expect(fs.readdirSync(path.join(root, 'taken'))).toEqual(['notes.txt']);
    expect(h.commands).toEqual([]);
  });

  it('writes into a non-empty directory with --force, keeping other files', async () => {
    fs.mkdirSync(path.join(root, 'taken'));
    fs.writeFileSync(path.join(root, 'taken', 'notes.txt'), 'mine');

    expect(await runInit(['taken', '--yes', '--force', '--no-install', '--no-git'], harness().environment)).toBe(0);
    expect(read('taken', 'notes.txt')).toBe('mine');
    expect(fs.existsSync(path.join(root, 'taken', 'package.json'))).toBe(true);
  });

  it('accepts an existing empty directory', async () => {
    fs.mkdirSync(path.join(root, 'empty'));
    expect(await runInit(['empty', '--yes', '--no-install', '--no-git'], harness().environment)).toBe(0);
  });

  it.each([
    [['--provider', 'gemini'], /invalid --provider 'gemini'.*openai, anthropic, openrouter, ollama/],
    [['--template', 'huge'], /invalid --template 'huge'.*minimal, tools, yaml/],
    [['--package-manager', 'deno'], /invalid --package-manager 'deno'.*npm, pnpm, yarn, bun/],
    [['--wat'], /--wat/],
  ])('rejects bad flags %j with a clear message', async (flags, message) => {
    const h = harness();
    expect(await runInit(['x', '--yes', ...flags], h.environment)).toBe(1);
    expect(h.err.join('')).toMatch(message);
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
  });

  it('prints usage for --help', async () => {
    const h = harness();
    expect(await runInit(['--help'], h.environment)).toBe(0);
    expect(h.out.join('')).toContain('Usage: lousho init');
  });

  it('reports a failed install, still prints next steps, and exits 1', async () => {
    const h = harness({}, 1);
    expect(await runInit(['demo', '--yes'], h.environment)).toBe(1);
    expect(h.err.join('')).toContain('`npm install` failed');
    expect(h.err.join('')).toContain('--sdk-path');
    expect(h.out.join('')).toContain('Next steps:');
    expect(h.out.join('')).toMatch(/\n {2}npm install\n/);
  });
});

describe('runInit interactive', () => {
  it('prompts for what the flags left out, with detected defaults', async () => {
    prompts.inject(['asked', 'openrouter', 'tools']);
    const h = harness({ interactive: true });

    expect(await runInit(['--no-install', '--no-git'], h.environment)).toBe(0);

    expect(read('asked', 'src', 'agent.ts')).toContain("model: 'openrouter/");
    expect(read('asked', 'src', 'agent.ts')).toContain('roll_die');
  });

  it('does not prompt with --yes even on a terminal', async () => {
    const h = harness({ interactive: true });
    expect(await runInit(['--yes', '--no-install', '--no-git'], h.environment)).toBe(0);
    expect(fs.existsSync(path.join(root, 'my-agent'))).toBe(true);
  });

  it('exits 1 when the user cancels', async () => {
    prompts.inject([new Error('cancel')]);
    const h = harness({ interactive: true });
    expect(await runInit([], h.environment)).toBe(1);
    expect(h.err.join('')).toContain('cancelled');
  });
});
