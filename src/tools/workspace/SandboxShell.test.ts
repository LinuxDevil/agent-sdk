import { describe, it, expect, vi } from 'vitest';
import { NoopSandbox, type SandboxAdapter, type SandboxResult, type SandboxRunOptions } from '../../security/sandboxCore';
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
    expect(sandbox.run).toHaveBeenCalledWith('sh', ['-c', 'npm test'], {
      cwd: '/work/project/pkg',
      env: { CI: '1' },
      inheritEnv: false,
      timeoutMs: 1000,
    });
    await new SandboxShell(sandbox, { shell: 'bash' }).exec('ls');
    expect(sandbox.run).toHaveBeenLastCalledWith('bash', ['-c', 'ls'], { cwd: undefined, env: {}, inheritEnv: false, timeoutMs: undefined });
    await new SandboxShell(sandbox).exec('ls', { cwd: 'sub' });
    expect(sandbox.run).toHaveBeenLastCalledWith('sh', ['-c', 'ls'], { cwd: 'sub', env: {}, inheritEnv: false, timeoutMs: undefined });
  });

  it('passes only set values and allowed host names, never planted secrets (LOU-X11)', async () => {
    Object.assign(process.env, { FAKE_SECRET_FOR_TEST: 'fake-secret-x11', FAKE_ALLOWED_FOR_TEST: 'allowed-x11' });
    try {
      const sandbox = fakeSandbox(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
      await new SandboxShell(sandbox, { env: { FOO: 'bar', CI: '0' }, inheritEnv: ['FAKE_ALLOWED_FOR_TEST'] }).exec('env', { env: { CI: '1' } });
      expect(sandbox.run).toHaveBeenLastCalledWith('sh', ['-c', 'env'], expect.objectContaining({
        env: { FOO: 'bar', CI: '1', FAKE_ALLOWED_FOR_TEST: 'allowed-x11' },
        inheritEnv: false,
      }));
      await new SandboxShell(sandbox, { inheritEnv: true }).exec('env');
      expect(sandbox.run).toHaveBeenLastCalledWith('sh', ['-c', 'env'], expect.objectContaining({ env: {}, inheritEnv: true }));

      // On the host (NoopSandbox) the command gets the shell base, never the rest of the host env.
      // `sh -c <script>` becomes `node -e <script>` so this runs the same on every platform.
      const hostNode: SandboxAdapter = { ...NoopSandbox, run: (_cmd, args, opts) => NoopSandbox.run(process.execPath, ['-e', args[1]], opts) };
      const script = "process.stdout.write([process.env.FAKE_SECRET_FOR_TEST||'absent',process.env.FOO,process.env.PATH?'path':'nopath'].join(','))";
      const onHost = new SandboxShell(hostNode, { env: { FOO: 'bar' } });
      expect((await onHost.exec(script)).stdout).toBe('absent,bar,path');
      const optedOut = new SandboxShell(hostNode, { inheritEnv: true });
      expect((await optedOut.exec("process.stdout.write(process.env.FAKE_SECRET_FOR_TEST||'absent')")).stdout).toBe('fake-secret-x11');
    } finally {
      delete process.env.FAKE_SECRET_FOR_TEST;
      delete process.env.FAKE_ALLOWED_FOR_TEST;
    }
    // Two real `node -e` child processes: slow to start when parallel suites load the machine (#330).
  }, 30_000);

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
