import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runAdd, parseAddArgs, type AddIo } from './add';
import { planFiles } from './addWrite';
import type { RegistryItem } from './registry';

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
  files: [{ path: 'tools/web-search.ts', content: 'export default {};\n' }],
  permissions: { network: ['api.example.com'], env: ['SEARCH_KEY'], filesystem: 'none', exec: false, needsApproval: true },
  dependencies: ['zod', 'undici'],
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
  writeJson(registry, {
    items: [
      { name: 'web-search', type: 'tool', description: 'Search the web', path: 'web-search.json' },
      { name: 'triage', type: 'skill', description: 'Triage tickets', path: 'triage.json' },
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
    const result = await add(withRegistry('web-search', '--yes'));
    expect(result.code).toBe(0);
    expect(result.out).toContain('network:    api.example.com');
    expect(result.out).toContain('env vars:   SEARCH_KEY');
    expect(result.out).toContain('approval:   its tools ask for approval');
    expect(result.out).toContain('tools/web-search.ts');
    expect(result.out).toContain('npm install zod undici');
    expect(fs.readFileSync(path.join(agentDir, 'tools', 'web-search.ts'), 'utf8')).toBe('export default {};\n');
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

  it('refuses to overwrite an existing file unless --overwrite', async () => {
    fs.mkdirSync(path.join(agentDir, 'tools'));
    const target = path.join(agentDir, 'tools', 'web-search.ts');
    fs.writeFileSync(target, 'mine');
    const refused = await add(withRegistry('web-search', '--yes'));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('LOUSHO_REGISTRY_FILE_EXISTS');
    expect(fs.readFileSync(target, 'utf8')).toBe('mine');
    expect((await add(withRegistry('web-search', '--yes', '--overwrite'))).code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('export default {};\n');
  });

  it('--list prints the index', async () => {
    const result = await add(['--list', '--registry', registry]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/web-search\s+tool\s+Search the web/);
    expect(result.out).toMatch(/triage\s+skill\s+Triage tickets/);
  });

  it('reads LOUSHO_REGISTRY, and without a registry says how to pass --registry', async () => {
    expect((await add(['--list'], { env: { LOUSHO_REGISTRY: registry } })).code).toBe(0);
    const none = await add(['--list']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('--registry');
    expect(none.err).toContain('LOUSHO_CONFIG_INVALID');
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
    const result = await add(['web-search', '--yes', '--registry', 'https://reg.example/r/index.json', '--dir', 'agent'], { fetch: fetchStub });
    expect(result.code).toBe(0);
    expect(seen).toEqual(['https://reg.example/r/index.json', 'https://reg.example/r/items/web-search.json']);
    const down = await add(['--list', '--registry', 'https://reg.example/missing.json'], { fetch: fetchStub });
    expect(down.err).toContain('HTTP 404');
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
