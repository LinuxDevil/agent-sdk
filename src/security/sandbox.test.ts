import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoopSandbox, SandboxAdapter } from './sandbox';

const execFileAsync = promisify(execFile);

describe('NoopSandbox', () => {
  it('run() produces the same stdout/exitCode as running the command directly via child_process', async () => {
    // Use node itself (process.execPath) with an inline script - reliable
    // across platforms (Windows/macOS/Linux) unlike shell builtins like
    // `echo`, which differ between cmd.exe and POSIX shells.
    const script = 'console.log("hello")';

    const direct = await execFileAsync(process.execPath, ['-e', script]);
    const viaSandbox = await NoopSandbox.run(process.execPath, ['-e', script]);

    expect(viaSandbox.stdout.trim()).toBe(direct.stdout.trim());
    expect(viaSandbox.exitCode).toBe(0);
  });

  it('run() surfaces a non-zero exit code as a result rather than throwing', async () => {
    const result = await NoopSandbox.run(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('writeFile() writes the given content to the given path', async () => {
    const filePath = join(tmpdir(), `noop-sandbox-test-${Date.now()}.txt`);
    try {
      await NoopSandbox.writeFile(filePath, 'hello sandbox');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('hello sandbox');
    } finally {
      await unlink(filePath).catch(() => {});
    }
  });

  it('has the expected adapter name', () => {
    expect(NoopSandbox.name).toBe('noop');
  });
});

// Compile-time check (also exercised by `tsc --noEmit`): a minimal
// alternate object implementing SandboxAdapter type-checks fine.
const _altSandbox: SandboxAdapter = {
  name: 'alt',
  async run() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  async writeFile() {
    // no-op
  },
};
void _altSandbox;
