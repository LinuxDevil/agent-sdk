import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { VERSION } from '../index';
import { detectTarget } from './devReload';

const BIN = path.resolve(__dirname, '..', '..', 'bin', 'lousho.js');

function lousho(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

describe('bin/lousho.js', () => {
  it.each(['--version', '-v', 'version'])('prints the package version for %s (Eve CLI-F9)', (flag) => {
    const res = lousho(flag);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(VERSION);
  });

  it('keeps the top-level usage in step with the commands (Eve CLI-F10)', () => {
    const banner = lousho('--help').stdout;
    expect(banner).toContain('lousho doctor [agent.yaml|json] [--json] [--ping]');
    expect(banner).toContain('[--timeout <ms>]');
    expect(banner).toContain('lousho --version');
  });
});

describe('detectTarget command name (Eve CLI-F8)', () => {
  it('names the calling command in a missing-path error', () => {
    expect(() => detectTarget('./nope.ts', 'chat')).toThrow(/lousho chat: '\.\/nope\.ts' does not exist/);
    expect(() => detectTarget('./nope.ts', 'acp')).toThrow(/lousho acp:/);
    expect(() => detectTarget('./nope.ts')).toThrow(/lousho dev:/);
  });
});
