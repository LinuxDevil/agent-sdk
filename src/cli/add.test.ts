import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { resolveAgentDir } from '../agentDir';
import { runAdd, parseAddArgs, type AddIo } from './add';
import { planFiles } from './addWrite';
import { DEFAULT_REGISTRY, type RegistryItem } from './registry';

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

const SEARCH = {
  name: 'web-search',
  type: 'tool',
  description: 'Search the web',
  files: [
    {
      path: 'tools/web-search.ts',
      content: "// Calls the Example Search API.\nexport default async (q: string) => (await fetch(`https://api.example.com/search?q=${q}`, { headers: { key: process.env.SEARCH_KEY ?? '' } })).json();\n",
    },
  ],
  permissions: { network: ['api.example.com'], env: ['SEARCH_KEY'], filesystem: 'none', exec: false, needsApproval: true },
  dependencies: ['zod', 'undici'],
};
const SEARCH_CONTENT = SEARCH.files[0].content;
const SHELL = {
  name: 'shell',
  type: 'tool',
  description: 'Run a command',
  files: [{ path: 'tools/shell.ts', content: "import { execSync } from 'node:child_process';\nexport default (cmd: string) => execSync(cmd).toString();\n" }],
  permissions: { exec: true },
};
const SKILL = {
  name: 'triage',
  type: 'skill',
  description: 'Triage tickets',
  files: [{ path: 'skills/triage/SKILL.md', content: '# Triage\n' }],
  permissions: {},
};

let root: string;
let agentDir: string;
let registry: string;

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-add-'));
  agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir);
  registry = path.join(root, 'index.json');
  writeJson(path.join(root, 'web-search.json'), SEARCH);
  writeJson(path.join(root, 'triage.json'), SKILL);
  writeJson(path.join(root, 'shell.json'), SHELL);
  writeJson(registry, {
    items: [
      { name: 'web-search', type: 'tool', description: 'Search the web', path: 'web-search.json' },
      { name: 'triage', type: 'skill', description: 'Triage tickets', path: 'triage.json' },
      { name: 'shell', type: 'tool', description: 'Run a command', path: 'shell.json' },
    ],
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function add(args: string[], options: { stdin?: string; tty?: boolean; fetch?: typeof fetch; env?: AddIo['env'] } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: options.tty ?? false });
  stdin.end(options.stdin ?? '');
  const out = sink();
  const err = sink();
  const code = await runAdd(args, { stdin, stdout: out.stream, stderr: err.stream, cwd: root, fetch: options.fetch, env: options.env ?? {} });
  return { code, out: out.text(), err: err.text() };
}

const withRegistry = (...rest: string[]) => [...rest, '--registry', registry, '--dir', 'agent'];

describe('lousho add', () => {
  it('parses its flags and needs a name or --list', () => {
    expect(parseAddArgs(['x', '--yes', '--dry-run', '--overwrite']).dryRun).toBe(true);
    expect(parseAddArgs(['--list']).list).toBe(true);
    expect(() => parseAddArgs([])).toThrow(/item name is required/);
    expect(() => parseAddArgs(['x', '--nope'])).toThrow(/unknown option/);
  });

  it('prints the manifest and files, then writes with --yes, and prints dependencies without installing', async () => {
    const result = await add(withRegistry('web-search', '--yes', '--allow', 'network,env'));
    expect(result.code).toBe(0);
    expect(result.out).toContain('network:    api.example.com  [elevated: network]');
    expect(result.out).toContain('env vars:   SEARCH_KEY  [elevated: env]');
    expect(result.out).toContain('approval:   its tools ask for approval');
    expect(result.out).toContain('tools/web-search.ts');
    expect(result.out).toContain('npm install zod undici');
    expect(fs.readFileSync(path.join(agentDir, 'tools', 'web-search.ts'), 'utf8')).toBe(SEARCH_CONTENT);
    expect(fs.existsSync(path.join(agentDir, 'package.json'))).toBe(false);
  });

  it('installs a skill under skills/<name>/ and shows the defaults for an empty manifest', async () => {
    const result = await add(withRegistry('triage', '--yes'));
    expect(result.out).toContain('filesystem: none');
    expect(result.out).toContain('its tools run without asking');
    expect(fs.existsSync(path.join(agentDir, 'skills', 'triage', 'SKILL.md'))).toBe(true);
  });

  it('asks for confirmation: yes writes, no cancels', async () => {
    const yes = await add(withRegistry('web-search'), { stdin: 'y\n', tty: true });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('[y/N]');
    expect(fs.existsSync(path.join(agentDir, 'tools', 'web-search.ts'))).toBe(true);
    fs.rmSync(path.join(agentDir, 'tools'), { recursive: true });
    const no = await add(withRegistry('web-search'), { stdin: 'n\n', tty: true });
    expect(no.code).toBe(1);
    expect(no.out).toContain('Cancelled');
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
  });

  it('refuses to ask on a non-interactive stdin without --yes', async () => {
    const result = await add(withRegistry('web-search'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('pass --yes');
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
  });

  it('--dry-run prints and writes nothing', async () => {
    const result = await add(withRegistry('web-search', '--dry-run'));
    expect(result.code).toBe(0);
    expect(result.out).toContain('Dry run');
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
  });

  it('--dry-run prints and exits 0 when the target file already exists', async () => {
    fs.mkdirSync(path.join(agentDir, 'tools'));
    const target = path.join(agentDir, 'tools', 'web-search.ts');
    fs.writeFileSync(target, 'mine');
    const result = await add(withRegistry('web-search', '--dry-run'));
    expect(result.code).toBe(0);
    expect(result.out).toContain('tools/web-search.ts (exists - a real install needs --overwrite)');
    expect(result.out).toContain('Dry run');
    expect(fs.readFileSync(target, 'utf8')).toBe('mine');
  });

  it('refuses to overwrite an existing file unless --overwrite', async () => {
    fs.mkdirSync(path.join(agentDir, 'tools'));
    const target = path.join(agentDir, 'tools', 'web-search.ts');
    fs.writeFileSync(target, 'mine');
    const refused = await add(withRegistry('web-search', '--yes', '--allow', 'network,env'));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('LOUSHO_REGISTRY_FILE_EXISTS');
    expect(fs.readFileSync(target, 'utf8')).toBe('mine');
    expect((await add(withRegistry('web-search', '--yes', '--allow', 'network,env', '--overwrite'))).code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(SEARCH_CONTENT);
  });

  it('--list prints the index', async () => {
    const result = await add(['--list', '--registry', registry]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/web-search\s+tool\s+Search the web/);
    expect(result.out).toMatch(/triage\s+skill\s+Triage tickets/);
  });

  it('reads LOUSHO_REGISTRY, falls back to the default registry, and none disables it', async () => {
    expect((await add(['--list'], { env: { LOUSHO_REGISTRY: registry } })).code).toBe(0);
    // With neither --registry nor LOUSHO_REGISTRY, lousho add fetches the default registry.
    const seen: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(fs.readFileSync(path.join(__dirname, '..', '..', 'registry', 'dist', 'index.json'), 'utf8'));
    }) as typeof fetch;
    const listed = await add(['--list'], { fetch: fetchStub });
    expect(listed.code).toBe(0);
    expect(seen).toEqual([DEFAULT_REGISTRY]);
    expect(listed.out).toContain('open-meteo-weather');
    // 'none' disables the default registry (offline or locked-down use): the old "no registry configured" error.
    const byFlag = await add(['--list', '--registry', 'none'], { fetch: fetchStub });
    expect(byFlag.code).toBe(1);
    expect(byFlag.err).toContain('LOUSHO_CONFIG_INVALID');
    expect(byFlag.err).toContain('no registry configured');
    const byEnv = await add(['--list'], { env: { LOUSHO_REGISTRY: 'none' }, fetch: fetchStub });
    expect(byEnv.code).toBe(1);
    expect(byEnv.err).toContain('LOUSHO_CONFIG_INVALID');
    // --registry and LOUSHO_REGISTRY still override the default (and 'none').
    const byFlagRegistry = await add(['--list', '--registry', registry], { env: { LOUSHO_REGISTRY: 'none' }, fetch: fetchStub });
    expect(byFlagRegistry.code).toBe(0);
    expect(byFlagRegistry.out).toContain('web-search');
    expect(seen).toEqual([DEFAULT_REGISTRY]);
  });

  it('suggests the closest name for an unknown item', async () => {
    const result = await add(withRegistry('web-serach', '--yes'));
    expect(result.err).toContain("Did you mean 'web-search'?");
    expect(result.err).toContain('LOUSHO_REGISTRY_ITEM_NOT_FOUND');
  });

  it('reports an unreachable registry and an invalid document with their codes', async () => {
    const missing = await add(['--list', '--registry', path.join(root, 'nope.json')]);
    expect(missing.err).toContain('LOUSHO_REGISTRY_UNREACHABLE');
    const scheme = await add(['--list', '--registry', 'file:///etc/passwd']);
    expect(scheme.err).toContain('only http(s) URLs and local paths');
    writeJson(path.join(root, 'web-search.json'), { name: 'web-search', type: 'tool', description: 'x' });
    const invalid = await add(withRegistry('web-search', '--yes'));
    expect(invalid.err).toContain('LOUSHO_REGISTRY_INVALID');
    expect(invalid.err).toContain('files');
  });

  it('works against a URL registry with an injected fetch, resolving relative item urls', async () => {
    const seen: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://reg.example/r/index.json') {
        return new Response(JSON.stringify({ items: [{ name: 'web-search', type: 'tool', description: 'd', url: 'items/web-search.json' }] }));
      }
      if (url === 'https://reg.example/r/items/web-search.json') return new Response(JSON.stringify(SEARCH));
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const result = await add(['web-search', '--yes', '--allow', 'network,env', '--registry', 'https://reg.example/r/index.json', '--dir', 'agent'], { fetch: fetchStub });
    expect(result.code).toBe(0);
    expect(seen).toEqual(['https://reg.example/r/index.json', 'https://reg.example/r/items/web-search.json']);
    const down = await add(['--list', '--registry', 'https://reg.example/missing.json'], { fetch: fetchStub });
    expect(down.err).toContain('HTTP 404');
  });
});

const receiptPath = () => path.join(agentDir, 'lousho-registry.json');
const readReceipt = () => JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('permission manifest', () => {
  it('refuses an item whose code does not match its manifest, and writes nothing', async () => {
    writeJson(path.join(root, 'shell.json'), { ...SHELL, permissions: { needsApproval: true } });
    const result = await add(withRegistry('shell', '--yes', '--allow', 'exec'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('LOUSHO_REGISTRY_MANIFEST_MISMATCH');
    expect(result.err).toContain("tools/shell.ts:1: import of 'node:child_process' (runs commands) (declare exec: true in permissions)");
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
    expect(fs.existsSync(receiptPath())).toBe(false);
  });

  it('refuses a mismatch on --dry-run too', async () => {
    writeJson(path.join(root, 'web-search.json'), { ...SEARCH, permissions: { network: ['api.example.com'] } });
    const result = await add(withRegistry('web-search', '--dry-run'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('reads process.env.SEARCH_KEY');
  });

  it('--yes without --allow refuses an exec item and names the missing flag; --allow exec installs it', async () => {
    const refused = await add(withRegistry('shell', '--yes'));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('missing: --allow exec');
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
    const partial = await add(withRegistry('web-search', '--yes', '--allow', 'network'));
    expect(partial.err).toContain('missing: --allow env');
    const allowed = await add(withRegistry('shell', '--yes', '--allow', 'exec'));
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('exec:       yes (runs commands)  [elevated: exec]');
    // exec alone makes its tools wait for approval (the receipt enforces it at load).
    expect(allowed.out).toContain('approval:   its tools ask for approval before they run');
    expect(fs.existsSync(path.join(agentDir, 'tools', 'shell.ts'))).toBe(true);
  });

  it('rejects an unknown --allow value', async () => {
    const result = await add(withRegistry('shell', '--yes', '--allow', 'exec,root'));
    expect(result.code).toBe(1);
    expect(result.err).toContain("got 'root'");
  });

  it('lists the elevated permissions in the interactive prompt', async () => {
    const result = await add(withRegistry('web-search'), { stdin: 'y\n', tty: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain('It asks for elevated permissions: network, env.');
    const skill = await add(withRegistry('triage'), { stdin: 'y\n', tty: true });
    expect(skill.out).not.toContain('elevated');
  });

  it('refuses a manifest with an invalid network or env entry', async () => {
    writeJson(path.join(root, 'web-search.json'), { ...SEARCH, permissions: { network: ['https://api.example.com/x'], env: ['search key'] } });
    const result = await add(withRegistry('web-search', '--dry-run'));
    expect(result.err).toContain('LOUSHO_REGISTRY_INVALID');
    expect(result.err).toContain('permissions.network');
    expect(result.err).toContain('permissions.env');
  });
});

describe('install receipt', () => {
  it('records each item with sha256 values, replaces the entry on --overwrite, and the directory still loads', async () => {
    expect((await add(withRegistry('web-search', '--yes', '--allow', 'network,env'))).code).toBe(0);
    expect((await add(withRegistry('triage', '--yes'))).code).toBe(0);
    const first = readReceipt();
    expect(first.v).toBe(1);
    expect(Object.keys(first.items)).toEqual(['triage', 'web-search']);
    expect(first.items['web-search']).toMatchObject({
      type: 'tool',
      registry,
      permissions: SEARCH.permissions,
      files: [{ path: 'tools/web-search.ts', sha256: sha(SEARCH_CONTENT) }],
    });
    expect(first.items['web-search'].installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.items.triage.files).toEqual([{ path: 'skills/triage/SKILL.md', sha256: sha('# Triage\n') }]);
    expect(fs.readFileSync(receiptPath(), 'utf8')).toMatch(/^\{\n {2}"items": \{\n {4}"triage": \{\n {6}"files"/);

    const changed = "export default async () => (await fetch('https://api.example.com/v2')).json();\n";
    writeJson(path.join(root, 'web-search.json'), { ...SEARCH, files: [{ path: 'tools/web-search.ts', content: changed }], permissions: { network: ['api.example.com'] } });
    expect((await add(withRegistry('web-search', '--yes', '--allow', 'network', '--overwrite'))).code).toBe(0);
    const second = readReceipt();
    expect(second.items['web-search'].files).toEqual([{ path: 'tools/web-search.ts', sha256: sha(changed) }]);
    expect(second.items['web-search'].permissions).toEqual({ network: ['api.example.com'] });
    expect(second.items.triage).toEqual(first.items.triage);

    // The receipt sits at the root next to instructions.md; the loader ignores it.
    // (The fixture tool and skill are not loadable code, so they go first.)
    fs.rmSync(path.join(agentDir, 'tools'), { recursive: true });
    fs.rmSync(path.join(agentDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'instructions.md'), 'You help.');
    const { config, manifest } = await resolveAgentDir(agentDir);
    expect(config.instructions).toBe('You help.');
    expect(manifest.files.map((file) => path.basename(file))).toEqual(['instructions.md']);
  });

  it('--dry-run writes no receipt', async () => {
    expect((await add(withRegistry('web-search', '--dry-run'))).code).toBe(0);
    expect(fs.existsSync(receiptPath())).toBe(false);
  });

  it('refuses to install over a receipt that is not valid, before writing any file', async () => {
    fs.writeFileSync(receiptPath(), '{ nope');
    const result = await add(withRegistry('triage', '--yes'));
    expect(result.err).toContain('LOUSHO_REGISTRY_INVALID');
    expect(result.err).toContain('install receipt');
    expect(fs.existsSync(path.join(agentDir, 'skills'))).toBe(false);
  });
});

describe('unsafe paths', () => {
  const dir = path.resolve('agent-dir');
  const item = (type: RegistryItem['type'], file: string, content = 'x'): RegistryItem => ({
    name: 'thing',
    type,
    description: '',
    files: [{ path: file, content }],
    permissions: {},
  });
  const unsafe = [
    ['parent segment', 'tools/../../evil.ts'],
    ['leading parent', '../tools/evil.ts'],
    ['absolute posix', '/etc/passwd'],
    ['absolute windows', 'C:\\Windows\\evil.ts'],
    ['drive letter, forward slash', 'C:/tools/evil.ts'],
    ['drive-relative', 'C:tools/evil.ts'],
    ['backslash separator', 'tools\\evil.ts'],
    ['backslash traversal', 'tools\\..\\..\\evil.ts'],
    ['UNC path', '\\\\server\\share\\evil.ts'],
    ['dot segment', 'tools/./evil.ts'],
    ['double slash', 'tools//evil.ts'],
    ['NUL byte', 'tools/evil.ts\0.png'],
    ['outside the type folder', 'schedules/evil.ts'],
    ['the folder itself', 'tools/'],
    ['empty', ''],
  ];
  it.each(unsafe)('rejects %s', (_label, file) => {
    expect(() => planFiles(item('tool', file), dir)).toThrow(/LOUSHO_REGISTRY_UNSAFE_PATH/);
  });

  it.each([
    ['tool', 'tools/a.ts'],
    ['channel', 'channels/a.ts'],
    ['schedule', 'schedules/a.ts'],
    ['memory', 'memory/a.ts'],
    ['skill', 'skills/thing/SKILL.md'],
  ] as const)('allows a %s file at %s', (type, file) => {
    expect(planFiles(item(type, file), dir)[0].relative).toBe(file);
  });

  it('keeps a skill inside skills/<name>/', () => {
    expect(() => planFiles(item('skill', 'skills/other/SKILL.md'), dir)).toThrow(/UNSAFE_PATH/);
    expect(() => planFiles(item('tool', 'skills/thing/SKILL.md'), dir)).toThrow(/UNSAFE_PATH/);
  });

  it('caps a file and an item', () => {
    expect(() => planFiles(item('tool', 'tools/a.ts', 'x'.repeat(256 * 1024 + 1)), dir)).toThrow(/larger than/);
    const big: RegistryItem = { ...item('tool', 'tools/a.ts'), files: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `tools/${n}.ts`, content: 'x'.repeat(250 * 1024) })) };
    expect(() => planFiles(big, dir)).toThrow(/item is larger/);
  });

  it('writes nothing when any file of the item is unsafe', async () => {
    writeJson(path.join(root, 'web-search.json'), { ...SEARCH, files: [...SEARCH.files, { path: '../escape.ts', content: 'x' }] });
    const result = await add(withRegistry('web-search', '--yes'));
    expect(result.err).toContain('LOUSHO_REGISTRY_UNSAFE_PATH');
    expect(fs.existsSync(path.join(agentDir, 'tools'))).toBe(false);
  });

  it('refuses a symlink that leaves the agent directory', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(agentDir, 'tools'), 'junction');
    } catch {
      return; // symlinks not permitted on this machine
    }
    const result = await add(withRegistry('web-search', '--yes'));
    expect(result.err).toContain('LOUSHO_REGISTRY_UNSAFE_PATH');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
