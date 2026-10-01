import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import type { DefinedTool } from '../defineTool';
import { createFsTools, type FsToolsOptions } from './fsTools';
import { MemoryWorkspace } from './MemoryWorkspace';
import type { FsProvider } from './types';

function toolsByName(fs: FsProvider, options?: FsToolsOptions): Record<string, DefinedTool> {
  return Object.fromEntries(createFsTools(fs, options).map((t) => [t.name, t]));
}

/** Calls a tool's execute directly (no agent loop). */
function call(tool: DefinedTool, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
  return tool.tool.execute!(args, { toolCallId: 't', messages: [], abortSignal });
}

describe('createFsTools on MemoryWorkspace (LOU-X6)', () => {
  it('creates all six tools, or only the read-only four with readOnly', () => {
    const ws = new MemoryWorkspace();
    expect(createFsTools(ws).map((t) => t.name)).toEqual(['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep']);
    expect(createFsTools(ws, { readOnly: true }).map((t) => t.name)).toEqual(['read_file', 'list_dir', 'glob', 'grep']);
  });

  it('needs no approval by default; per-tool overrides apply', async () => {
    const tools = toolsByName(new MemoryWorkspace(), {
      needsApproval: { write_file: true, edit_file: ({ path }) => path.startsWith('protected/') },
    });
    expect(tools.read_file.needsApproval).toBeUndefined();
    expect(tools.write_file.needsApproval).toBe(true);
    const predicate = tools.edit_file.needsApproval as (args: { path: string }) => boolean;
    expect(predicate({ path: 'protected/a' })).toBe(true);
    expect(predicate({ path: 'src/a' })).toBe(false);
  });

  describe('read_file', () => {
    it('returns numbered lines', async () => {
      const { read_file } = toolsByName(new MemoryWorkspace({ files: { 'a.txt': 'one\ntwo\r\nthree\n' } }));
      expect(await call(read_file, { path: 'a.txt' })).toBe('     1\tone\n     2\ttwo\n     3\tthree');
    });

    it('pages with offset/limit and says how to continue', async () => {
      const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
      const { read_file } = toolsByName(new MemoryWorkspace({ files: { 'a.txt': content } }));
      expect(await call(read_file, { path: 'a.txt', offset: 3, limit: 2 })).toBe(
        '     3\tline 3\n     4\tline 4\n[Truncated: showing lines 3-4 of 10. Call read_file with offset=5 to read more.]'
      );
      await expect(call(read_file, { path: 'a.txt', offset: 11 })).rejects.toThrow(/past the end of a.txt, which has 10 lines/);
    });

    it('caps lines and characters', async () => {
      const content = Array.from({ length: 50 }, () => 'x'.repeat(100)).join('\n');
      const tools = toolsByName(new MemoryWorkspace({ files: { 'a.txt': content, 'long.txt': 'y'.repeat(5000) } }), {
        maxReadLines: 20,
        maxOutputChars: 500,
      });
      const out = (await call(tools.read_file, { path: 'a.txt' })) as string;
      expect(out).toMatch(/\[Truncated: showing lines 1-4 of 50\. Call read_file with offset=5/);
      expect(out.length).toBeLessThan(700);
      const long = (await call(tools.read_file, { path: 'long.txt' })) as string;
      expect(long).toContain('[line truncated]');
    });

    it('refuses files too large to load, and grep skips them', async () => {
      const ws = new MemoryWorkspace({ files: { 'huge.log': 'x'.repeat(10_000_001), 'small.log': 'x' } });
      const tools = toolsByName(ws);
      await expect(call(tools.read_file, { path: 'huge.log' })).rejects.toThrow(/huge\.log is too large to read \(10000001 bytes\)/);
      expect(await call(tools.grep, { pattern: 'x' })).toBe('small.log:1: x');
    });

    it('reports empty, binary, missing and directory paths', async () => {
      const { read_file } = toolsByName(new MemoryWorkspace({ files: { 'e.txt': '', 'b.bin': 'a\0b', 'd/x': '' } }));
      expect(await call(read_file, { path: 'e.txt' })).toBe('e.txt is empty.');
      expect(await call(read_file, { path: 'b.bin' })).toMatch(/binary file/);
      await expect(call(read_file, { path: 'nope.txt' })).rejects.toThrow('File not found: nope.txt');
      await expect(call(read_file, { path: 'd' })).rejects.toThrow('d is a directory, not a file.');
    });
  });

  it('write_file creates parent directories and reports the size', async () => {
    const ws = new MemoryWorkspace();
    const { write_file, list_dir } = toolsByName(ws);
    expect(await call(write_file, { path: 'a/b/c.txt', content: 'héllo' })).toBe('Wrote 6 bytes to a/b/c.txt.');
    expect(ws.snapshot()).toEqual({ 'a/b/c.txt': 'héllo' });
    expect(await call(list_dir, { path: 'a' })).toBe('b/');
  });

  describe('edit_file', () => {
    it('replaces a unique occurrence', async () => {
      const ws = new MemoryWorkspace({ files: { 'a.ts': 'const a = 1;\nconst b = 2;\n' } });
      const { edit_file } = toolsByName(ws);
      expect(await call(edit_file, { path: 'a.ts', old_string: 'b = 2', new_string: 'b = $&3' })).toBe(
        'Edited a.ts: replaced 1 occurrence.'
      );
      expect(ws.snapshot()['a.ts']).toBe('const a = 1;\nconst b = $&3;\n');
    });

    it('refuses a non-unique old_string unless replace_all', async () => {
      const ws = new MemoryWorkspace({ files: { 'a.ts': 'x x x' } });
      const { edit_file } = toolsByName(ws);
      await expect(call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'y' })).rejects.toThrow(
        'old_string appears 3 times in a.ts. Include more surrounding lines to make it unique, or pass replace_all: true to replace every occurrence.'
      );
      expect(ws.snapshot()['a.ts']).toBe('x x x');
      expect(await call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })).toBe(
        'Edited a.ts: replaced 3 occurrences.'
      );
      expect(ws.snapshot()['a.ts']).toBe('y y y');
    });

    it('explains a missing old_string, with a CRLF hint when relevant', async () => {
      const { edit_file } = toolsByName(new MemoryWorkspace({ files: { 'a.ts': 'one\r\ntwo\r\n' } }));
      await expect(call(edit_file, { path: 'a.ts', old_string: 'three', new_string: 'x' })).rejects.toThrow(
        /old_string was not found in a.ts\. Call read_file and copy the exact text/
      );
      await expect(call(edit_file, { path: 'a.ts', old_string: 'one\ntwo', new_string: 'x' })).rejects.toThrow(/CRLF line endings/);
    });

    it('rejects empty and no-op edits', async () => {
      const { edit_file } = toolsByName(new MemoryWorkspace({ files: { 'a.ts': 'x' } }));
      await expect(call(edit_file, { path: 'a.ts', old_string: '', new_string: 'y' })).rejects.toThrow(/use write_file/);
      await expect(call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'x' })).rejects.toThrow(/identical/);
    });
  });

  it('list_dir sorts entries, marks directories and caps the list', async () => {
    const ws = new MemoryWorkspace({ files: { 'b.txt': '', 'a/x.txt': '', 'c.txt': '' } });
    expect(await call(toolsByName(ws).list_dir, {})).toBe('a/\nb.txt\nc.txt');
    expect(await call(toolsByName(ws, { maxResults: 2 }).list_dir, {})).toBe('a/\nb.txt\n[Truncated: showing 2 of 3 entries.]');
    await ws.mkdir('empty');
    expect(await call(toolsByName(ws).list_dir, { path: 'empty' })).toBe('empty is empty.');
    await expect(call(toolsByName(ws).list_dir, { path: 'b.txt' })).rejects.toThrow('b.txt is a file, not a directory.');
  });

  describe('glob', () => {
    const files = {
      'src/a.ts': '',
      'src/b.js': '',
      'src/deep/c.ts': '',
      'README.md': '',
      'node_modules/pkg/index.ts': '',
      '.git/config.ts': '',
    };

    it('returns sorted matches and skips ignored directories', async () => {
      const { glob } = toolsByName(new MemoryWorkspace({ files }));
      expect(await call(glob, { pattern: '**/*.ts' })).toBe('src/a.ts\nsrc/deep/c.ts');
      expect(await call(glob, { pattern: '*.ts', path: 'src' })).toBe('src/a.ts');
      expect(await call(glob, { pattern: '*.md' })).toBe('README.md');
      expect(await call(glob, { pattern: '*.py' })).toBe('No files match "*.py" under ..');
    });

    it('caps results and the number of files scanned', async () => {
      const ws = new MemoryWorkspace({ files });
      expect(await call(toolsByName(ws, { maxResults: 1 }).glob, { pattern: '**' })).toMatch(/^README\.md\n\[Truncated: showing 1 of 4 matches\.\]$/);
      expect(await call(toolsByName(ws, { maxFilesScanned: 1 }).glob, { pattern: '**' })).toMatch(/Stopped after scanning 1 files/);
      expect(await call(toolsByName(ws, { ignore: [] }).glob, { pattern: '**/index.ts' })).toBe('node_modules/pkg/index.ts');
    });

    it('rejects patterns and paths that escape the workspace', async () => {
      const { glob } = toolsByName(new MemoryWorkspace({ files }));
      await expect(call(glob, { pattern: '../**' })).rejects.toThrow(/outside the workspace/);
      await expect(call(glob, { pattern: '*', path: '/etc' })).rejects.toThrow(/outside the workspace/);
    });

    it("uses the provider's own glob when it has one", async () => {
      const ws = new MemoryWorkspace();
      const provider: FsProvider = Object.assign(Object.create(ws) as FsProvider, {
        glob: async (pattern: string) => [`${pattern}-b`, `${pattern}-a`, `${pattern}-a`],
      });
      expect(await call(toolsByName(provider).glob, { pattern: '*.ts', path: 'src' })).toBe('src/*.ts-a\nsrc/*.ts-b');
    });

    it('stops when the run is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(call(toolsByName(new MemoryWorkspace({ files })).glob, { pattern: '**' }, controller.signal)).rejects.toThrow(/cancelled/);
    });
  });

  describe('grep', () => {
    const files = {
      'src/a.ts': 'export function main() {}\nconst x = 1;\n',
      'src/b.js': 'function helper() {}\n',
      'docs/readme.md': 'Function docs\n',
      'bin.dat': 'function\0binary',
    };

    it('returns path:line: text for matches, honoring glob and ignore_case', async () => {
      const { grep } = toolsByName(new MemoryWorkspace({ files }));
      expect(await call(grep, { pattern: 'function \\w+' })).toBe('src/a.ts:1: export function main() {}\nsrc/b.js:1: function helper() {}');
      expect(await call(grep, { pattern: 'function', glob: '**/*.ts' })).toBe('src/a.ts:1: export function main() {}');
      expect(await call(grep, { pattern: '^function', ignore_case: true, path: 'docs' })).toBe('docs/readme.md:1: Function docs');
      expect(await call(grep, { pattern: 'const', path: 'src/a.ts' })).toBe('src/a.ts:2: const x = 1;');
      expect(await call(grep, { pattern: 'nothing-here' })).toBe('No matches for "nothing-here".');
    });

    it('caps matches and long lines', async () => {
      const ws = new MemoryWorkspace({ files: { 'a.txt': 'hit\n'.repeat(10), 'b.txt': `hit ${'z'.repeat(1000)}` } });
      expect(await call(toolsByName(ws, { maxResults: 3 }).grep, { pattern: 'hit' })).toBe(
        'a.txt:1: hit\na.txt:2: hit\na.txt:3: hit\n[Truncated at 3 matches; narrow the pattern, path or glob.]'
      );
      expect(await call(toolsByName(ws).grep, { pattern: 'z', path: 'b.txt' })).toMatch(/\[line truncated\]$/);
    });

    it('turns an invalid regex or missing path into a clean error', async () => {
      const { grep } = toolsByName(new MemoryWorkspace({ files }));
      await expect(call(grep, { pattern: 'foo(' })).rejects.toThrow(/Invalid regular expression "foo\(":/);
      await expect(call(grep, { pattern: 'x', path: 'missing' })).rejects.toThrow('Path not found: missing');
    });

    it('stops when the run is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(call(toolsByName(new MemoryWorkspace({ files })).grep, { pattern: 'x' }, controller.signal)).rejects.toThrow(/cancelled/);
    });
  });

  it('a rejected path reaches the model as a tool error and the run continues', async () => {
    const provider = mockModel([{ toolCalls: [{ name: 'read_file', args: { path: '../../etc/passwd' } }] }, 'I cannot read that.']);
    const agent = createAgent({ prompt: 'p', provider, tools: createFsTools(new MemoryWorkspace()) });
    const result = await agent.send('read it');
    expect(result.text).toBe('I cannot read that.');
    const toolMessage = provider.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage?.isError).toBe(true);
    expect(JSON.parse(toolMessage!.content as string)).toMatchObject({
      error: 'WorkspaceError',
      toolName: 'read_file',
      message: expect.stringMatching(/outside the workspace/),
    });
  });
});

describe('MemoryWorkspace (LOU-X6)', () => {
  it('stats, removes and refuses invalid operations', async () => {
    const ws = new MemoryWorkspace({ files: { 'd/a.txt': 'abc' } });
    expect(await ws.stat('d/a.txt')).toEqual({ type: 'file', size: 3 });
    expect(await ws.stat('d')).toEqual({ type: 'directory', size: 0 });
    expect(await ws.stat('nope')).toBeUndefined();
    await expect(ws.rm('d')).rejects.toThrow(/not empty; pass \{ recursive: true \}/);
    await expect(ws.rm('.')).rejects.toThrow(/workspace root/);
    await expect(ws.rm('nope')).rejects.toThrow('Not found: nope');
    await expect(ws.writeFile('d', 'x')).rejects.toThrow('d is a directory, not a file.');
    await expect(ws.mkdir('d/a.txt')).rejects.toThrow('d/a.txt is a file, not a directory.');
    await expect(ws.writeFile('d/a.txt/b', 'x')).rejects.toThrow('d/a.txt is a file, not a directory.');
    await expect(ws.writeFile('.', 'x')).rejects.toThrow('. is a directory, not a file.');
    expect(() => new MemoryWorkspace({ files: { './': 'x' } })).toThrow(/workspace root/);
    await expect(ws.readdir('nope')).rejects.toThrow('Directory not found: nope');
    await ws.rm('d', { recursive: true });
    expect(await ws.stat('d')).toBeUndefined();
    await ws.mkdir('e');
    await ws.rm('e');
    await ws.writeFile('f.txt', 'x');
    await ws.rm('f.txt');
    expect(ws.snapshot()).toEqual({});
  });

  it('exec runs the scripted handler and records every call', async () => {
    const ws = new MemoryWorkspace({ exec: (command) => (command === 'ok' ? { stdout: 'yes\n' } : { exitCode: 2 }) });
    expect(await ws.exec('ok')).toEqual({ stdout: 'yes\n', stderr: '', exitCode: 0, timedOut: false });
    expect(await ws.exec('bad', { cwd: 'src', timeoutMs: 5 })).toMatchObject({ exitCode: 2 });
    expect(ws.commands).toEqual([
      { command: 'ok', options: {} },
      { command: 'bad', options: { cwd: 'src', timeoutMs: 5 } },
    ]);
  });

  it('exec without a handler fails with 127 and says how to program it', async () => {
    expect(await new MemoryWorkspace().exec('ls')).toMatchObject({ exitCode: 127, stderr: expect.stringMatching(/no exec handler/) });
  });
});
