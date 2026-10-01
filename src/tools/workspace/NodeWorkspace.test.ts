import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DefinedTool } from '../defineTool';
import { NodeWorkspace } from './NodeWorkspace';
import { createFsTools } from './fsTools';
import { createShellTool } from './shellTool';
import { WorkspaceError } from './paths';

const IS_WINDOWS = process.platform === 'win32';
const NODE = JSON.stringify(process.execPath);
/** A shell command running `node -e <script>`; the script must not contain `"`, `$`, `%` or `!`. */
const node = (script: string) => `${NODE} -e "${script}"`;

let tmp: string;
let rootDir: string;
let outsideDir: string;
let ws: NodeWorkspace;
let tools: Record<string, DefinedTool>;

function exec(tool: DefinedTool, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
  return tool.tool.execute!(args, { toolCallId: 'n', messages: [], abortSignal });
}

/** Creates a symlink, or returns the reason the OS refused (Windows needs a privilege for file symlinks). */
function trySymlink(target: string, link: string, type: 'file' | 'dir' | 'junction'): string | undefined {
  try {
    fs.symlinkSync(target, link, type);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-ws-')));
  rootDir = path.join(tmp, 'root');
  outsideDir = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export const a = 1;\n');
  ws = new NodeWorkspace({ root: rootDir });
  tools = Object.fromEntries(createFsTools(ws).map((t) => [t.name, t]));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('NodeWorkspace file system (LOU-X6)', () => {
  it('requires an existing root', () => {
    expect(() => new NodeWorkspace({ root: '' })).toThrow(/'root' is required/);
    expect(() => new NodeWorkspace({ root: path.join(tmp, 'missing') })).toThrow(/does not exist/);
    expect(() => new NodeWorkspace({ root: path.join(rootDir, 'src', 'a.ts') })).toThrow(/is a file, not a directory/);
    expect(ws.root).toBe(fs.realpathSync.native(rootDir));
  });

  it('reads, writes, lists, stats and removes inside the root', async () => {
    await ws.writeFile('new/dir/file.txt', 'hello');
    expect(fs.readFileSync(path.join(rootDir, 'new', 'dir', 'file.txt'), 'utf8')).toBe('hello');
    expect(await ws.readFile('new\\dir/file.txt')).toBe('hello');
    expect(await ws.stat('new/dir/file.txt')).toEqual({ type: 'file', size: 5 });
    expect(await ws.stat('new')).toMatchObject({ type: 'directory' });
    expect(await ws.stat('nope')).toBeUndefined();
    expect(await ws.readdir('new/dir')).toEqual([{ name: 'file.txt', type: 'file' }]);
    await ws.mkdir('made/here');
    expect(fs.statSync(path.join(rootDir, 'made', 'here')).isDirectory()).toBe(true);
    await expect(ws.rm('new')).rejects.toThrow('Directory new is not empty; pass { recursive: true } to remove it.');
    await ws.rm('new', { recursive: true });
    await ws.rm('made/here');
    expect(fs.existsSync(path.join(rootDir, 'new'))).toBe(false);
  });

  it('maps fs errors to workspace paths, never host paths', async () => {
    const missing = ws.readFile('src/missing.ts');
    await expect(missing).rejects.toThrow(WorkspaceError);
    await expect(missing).rejects.toThrow('File not found: src/missing.ts');
    await expect(ws.readFile('src')).rejects.toThrow('src is a directory, not a file.');
    await expect(ws.readdir('src/a.ts')).rejects.toThrow(/src\/a\.ts is not a directory/);
    await expect(ws.writeFile('.', 'x')).rejects.toThrow(/workspace root/);
    await expect(ws.rm('.')).rejects.toThrow(/workspace root/);
    await expect(ws.rm('src/a.ts/x')).rejects.toThrow(/not a directory|File not found/);
  });

  it('works through the fs tools', async () => {
    expect(await exec(tools.write_file, { path: 'tool/x.txt', content: 'a\nb\n' })).toBe('Wrote 4 bytes to tool/x.txt.');
    expect(await exec(tools.edit_file, { path: 'tool/x.txt', old_string: 'b', new_string: 'c' })).toMatch(/replaced 1/);
    expect(await exec(tools.read_file, { path: 'tool/x.txt' })).toBe('     1\ta\n     2\tc');
    expect(await exec(tools.grep, { pattern: 'export', glob: '**/*.ts' })).toBe('src/a.ts:1: export const a = 1;');
    expect(await exec(tools.glob, { pattern: '**/*.txt' })).toBe('tool/x.txt');
  });

  describe('confinement', () => {
    const secret = () => path.join(outsideDir, 'secret.txt');

    it.each([
      ['parent traversal', '../outside/secret.txt'],
      ['nested traversal', 'src/../../outside/secret.txt'],
      ['backslash traversal', '..\\outside\\secret.txt'],
      ['mixed separators', 'src/..\\..\\outside/secret.txt'],
      ['Windows drive letter', 'C:\\Windows\\win.ini'],
      ['drive-relative path', 'C:secret.txt'],
      ['UNC path', '\\\\server\\share\\secret.txt'],
      ['extended-length path', '\\\\?\\C:\\secret.txt'],
      ['forward-slash UNC path', '//server/share/secret.txt'],
    ])('rejects %s (%j) for read, write, stat, list and rm', async (_label, bad) => {
      for (const op of [
        () => ws.readFile(bad),
        () => ws.writeFile(bad, 'pwned'),
        () => ws.stat(bad),
        () => ws.readdir(bad),
        () => ws.mkdir(bad),
        () => ws.rm(bad),
      ]) {
        await expect(op()).rejects.toThrow(WorkspaceError);
      }
      await expect(exec(tools.read_file, { path: bad })).rejects.toThrow(/outside the workspace/);
      expect(fs.readFileSync(secret(), 'utf8')).toBe('TOP SECRET');
    });

    it('rejects the absolute host path of a file outside the root (and inside it)', async () => {
      await expect(ws.readFile(secret())).rejects.toThrow(/absolute|drive-letter/);
      await expect(ws.readFile(path.join(rootDir, 'src', 'a.ts'))).rejects.toThrow(/absolute|drive-letter/);
    });

    it('rejects a symlinked directory that points outside, including for new files', async (ctx) => {
      const link = path.join(rootDir, 'escape-dir');
      const refused = trySymlink(outsideDir, link, IS_WINDOWS ? 'junction' : 'dir');
      if (refused) {
        console.warn(`Skipping directory-symlink escape test: the OS refused to create a symlink (${refused}).`);
        ctx.skip();
        return;
      }
      await expect(ws.readFile('escape-dir/secret.txt')).rejects.toThrow(/resolves outside the workspace/);
      await expect(ws.writeFile('escape-dir/new.txt', 'pwned')).rejects.toThrow(/resolves outside the workspace/);
      await expect(ws.writeFile('escape-dir/deeper/new.txt', 'pwned')).rejects.toThrow(/resolves outside/);
      await expect(ws.readdir('escape-dir')).rejects.toThrow(/resolves outside/);
      await expect(ws.exec('echo hi', { cwd: 'escape-dir' })).rejects.toThrow(/resolves outside/);
      await expect(exec(tools.write_file, { path: 'escape-dir/x.txt', content: 'x' })).rejects.toThrow(/resolves outside/);
      expect(fs.existsSync(path.join(outsideDir, 'new.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outsideDir, 'deeper'))).toBe(false);
      // glob/grep walks never follow links out of the workspace.
      expect(await exec(tools.grep, { pattern: 'SECRET' })).toBe('No matches for "SECRET".');
      // rm removes the link itself, never the target.
      await ws.rm('escape-dir');
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readFileSync(secret(), 'utf8')).toBe('TOP SECRET');
    });

    it('rejects a symlinked file that points outside', async (ctx) => {
      const refused = trySymlink(secret(), path.join(rootDir, 'escape-file'), 'file');
      if (refused) {
        console.warn(`Skipping file-symlink escape test: the OS refused to create a symlink (${refused}); Windows needs Developer Mode or admin rights.`);
        ctx.skip();
        return;
      }
      await expect(ws.readFile('escape-file')).rejects.toThrow(/resolves outside the workspace/);
      await expect(ws.writeFile('escape-file', 'pwned')).rejects.toThrow(/resolves outside the workspace/);
      await expect(exec(tools.edit_file, { path: 'escape-file', old_string: 'TOP', new_string: 'x' })).rejects.toThrow(/resolves outside/);
      expect(fs.readFileSync(secret(), 'utf8')).toBe('TOP SECRET');
      await ws.rm('escape-file');
    });

    it('refuses to write through a dangling symlink', async (ctx) => {
      const target = path.join(outsideDir, 'not-yet');
      const refused = trySymlink(target, path.join(rootDir, 'dangling'), IS_WINDOWS ? 'junction' : 'dir');
      if (refused) {
        console.warn(`Skipping dangling-symlink test: the OS refused to create a symlink (${refused}).`);
        ctx.skip();
        return;
      }
      await expect(ws.writeFile('dangling/x.txt', 'pwned')).rejects.toThrow(/symlink whose target does not exist/);
      await expect(ws.mkdir('dangling/sub')).rejects.toThrow(/symlink whose target does not exist/);
      expect(fs.existsSync(target)).toBe(false);
      await ws.rm('dangling');
    });

    it('allows a symlink that stays inside the root', async (ctx) => {
      const refused = trySymlink(path.join(rootDir, 'src'), path.join(rootDir, 'inner'), IS_WINDOWS ? 'junction' : 'dir');
      if (refused) {
        console.warn(`Skipping inner-symlink test: the OS refused to create a symlink (${refused}).`);
        ctx.skip();
        return;
      }
      expect(await ws.readFile('inner/a.ts')).toBe('export const a = 1;\n');
      await ws.rm('inner');
      expect(fs.existsSync(path.join(rootDir, 'src', 'a.ts'))).toBe(true);
    });
  });
});

describe('NodeWorkspace shell (LOU-X6)', () => {
  it('returns stdout, stderr and the exit code', async () => {
    const result = await ws.exec(node("process.stdout.write('out');process.stderr.write('err');process.exit(3)"));
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3, timedOut: false });
  });

  it('runs in the root by default, or in a confined cwd', async () => {
    const cwdOf = async (cwd?: string) =>
      fs.realpathSync.native((await ws.exec(node('process.stdout.write(process.cwd())'), { cwd })).stdout);
    expect(await cwdOf()).toBe(ws.root);
    expect(await cwdOf('src')).toBe(path.join(ws.root, 'src'));
    await expect(ws.exec('echo hi', { cwd: '../outside' })).rejects.toThrow(/outside the workspace/);
    await expect(ws.exec('echo hi', { cwd: 'src/a.ts' })).rejects.toThrow(/not a directory/);
  });

  it('does not leak host environment variables (API keys) to commands', async () => {
    process.env.LOUSHY_TEST_SECRET = 'sk-test-should-not-leak';
    try {
      const script = "process.stdout.write([process.env.LOUSHY_TEST_SECRET||'absent',process.env.GIVEN||'none',process.env.PATH?'path':'nopath'].join(','))";
      expect((await new NodeWorkspace({ root: rootDir }).exec(node(script))).stdout).toBe('absent,none,path');
      const configured = new NodeWorkspace({ root: rootDir, env: { GIVEN: 'yes' }, inheritEnv: ['LOUSHY_TEST_SECRET'] });
      expect((await configured.exec(node(script))).stdout).toBe('sk-test-should-not-leak,yes,path');
      expect((await ws.exec(node(script), { env: { GIVEN: 'per-call' } })).stdout).toBe('absent,per-call,path');
    } finally {
      delete process.env.LOUSHY_TEST_SECRET;
    }
  });

  it('caps captured output, keeping head and tail', async () => {
    const small = new NodeWorkspace({ root: rootDir, maxOutputBytes: 1000 });
    const { stdout } = await small.exec(node("process.stdout.write('S'+'a'.repeat(100000)+'END')"));
    expect(stdout.startsWith('S')).toBe(true);
    expect(stdout.endsWith('END')).toBe(true);
    expect(stdout).toContain('bytes omitted');
    expect(stdout.length).toBeLessThan(1100);
  });

  it('rejects when the shell cannot be started', async () => {
    const broken = new NodeWorkspace({ root: rootDir, shell: path.join(tmp, 'no-such-shell') });
    await expect(broken.exec('echo hi')).rejects.toThrow(/Could not start the command/);
  });

  const spawnsGrandchild = node(
    "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
      "require('fs').writeFileSync('child.pid',String(c.pid));setTimeout(()=>{},60000)"
  );

  it('kills a long-running command and its children on timeout', async () => {
    fs.rmSync(path.join(rootDir, 'child.pid'), { force: true });
    const start = Date.now();
    const result = await ws.exec(spawnsGrandchild, { timeoutMs: 2500 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - start).toBeLessThan(15_000);
    const pid = Number(fs.readFileSync(path.join(rootDir, 'child.pid'), 'utf8'));
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  }, 30_000);

  it('kills the process tree when the run is aborted (through the shell tool)', async () => {
    fs.rmSync(path.join(rootDir, 'child.pid'), { force: true });
    const controller = new AbortController();
    const pidFile = path.join(rootDir, 'child.pid');
    void waitFor(() => fs.existsSync(pidFile)).then(() => controller.abort());
    const shell = createShellTool(ws, { needsApproval: false });
    const result = await exec(shell, { command: spawnsGrandchild }, controller.signal);
    expect(result).toMatchObject({ exitCode: null, aborted: true });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  }, 30_000);

  it('kills a plain long-running node child on timeout, and returns at once for an aborted signal', async () => {
    const result = await ws.exec(node('setTimeout(()=>{},60000)'), { timeoutMs: 300 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    const controller = new AbortController();
    controller.abort();
    expect(await ws.exec(node('setTimeout(()=>{},60000)'), { signal: controller.signal })).toEqual({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
    });
  }, 30_000);
});
