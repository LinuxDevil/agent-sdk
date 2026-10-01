import { describe, it, expect, vi } from 'vitest';
import type { SandboxAdapter, SandboxResult, SandboxRunOptions } from '../../security/sandboxCore';
import { SandboxShell } from './SandboxShell';
import { createShellTool } from './shellTool';

function fakeSandbox(run: (cmd: string, args: string[], opts?: SandboxRunOptions) => Promise<SandboxResult>) {
  const sandbox: SandboxAdapter = { name: 'fake', run: vi.fn(run), writeFile: vi.fn() };
  return sandbox;
}

describe('SandboxShell (LOU-X6)', () => {
  it('runs the command as sh -c in the configured cwd, with only the given env', async () => {
    const sandbox = fakeSandbox(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const shell = new SandboxShell(sandbox, { cwd: '/work/project/' });
    expect(await shell.exec('npm test', { cwd: 'pkg', env: { CI: '1' }, timeoutMs: 1000 })).toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    expect(sandbox.run).toHaveBeenCalledWith('sh', ['-c', 'npm test'], { cwd: '/work/project/pkg', env: { CI: '1' }, timeoutMs: 1000 });
    await new SandboxShell(sandbox, { shell: 'bash' }).exec('ls');
    expect(sandbox.run).toHaveBeenLastCalledWith('bash', ['-c', 'ls'], { cwd: undefined, env: undefined, timeoutMs: undefined });
    await new SandboxShell(sandbox).exec('ls', { cwd: 'sub' });
    expect(sandbox.run).toHaveBeenLastCalledWith('sh', ['-c', 'ls'], { cwd: 'sub', env: undefined, timeoutMs: undefined });
  });

  it('rejects a per-call cwd that escapes the base directory', async () => {
    const shell = new SandboxShell(fakeSandbox(async () => ({ stdout: '', stderr: '', exitCode: 0 })), { cwd: '/work' });
    await expect(shell.exec('ls', { cwd: '../etc' })).rejects.toThrow(/outside the workspace/);
  });

  it('reports a sandbox timeout as timedOut and rethrows other failures', async () => {
    const timeout = new SandboxShell(fakeSandbox(async () => Promise.reject(new Error('SubprocessSandbox: command timed out after 50ms'))));
    expect(await timeout.exec('sleep 9', { timeoutMs: 50 })).toEqual({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    const broken = new SandboxShell(fakeSandbox(async () => Promise.reject(new Error('docker daemon not running'))));
    await expect(broken.exec('ls', { timeoutMs: 50 })).rejects.toThrow('docker daemon not running');
  });

  it('stops waiting when the signal aborts', async () => {
    const shell = new SandboxShell(fakeSandbox(() => new Promise<SandboxResult>(() => {})));
    const controller = new AbortController();
    const pending = shell.exec('sleep 60', { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    expect(await pending).toMatchObject({ exitCode: null, aborted: true });
    const already = new AbortController();
    already.abort();
    expect(await shell.exec('ls', { signal: already.signal })).toMatchObject({ aborted: true });
    const done = new SandboxShell(fakeSandbox(async () => ({ stdout: 'x', stderr: '', exitCode: 0 })));
    expect(await done.exec('ls', { signal: new AbortController().signal })).toMatchObject({ stdout: 'x' });
  });

  it('backs the shell tool', async () => {
    const tool = createShellTool(new SandboxShell(fakeSandbox(async () => ({ stdout: 'hi', stderr: '', exitCode: 0 }))), {
      needsApproval: false,
    });
    expect(await tool.tool.execute!({ command: 'echo hi' }, { toolCallId: 'x', messages: [] })).toEqual({
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
    });
  });
});
