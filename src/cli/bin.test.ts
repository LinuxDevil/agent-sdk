import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
    expect(banner).toContain('lousho doctor [agent.yaml|json|agent-dir] [--json] [--ping]');
    // One-line descriptions and the build targets (a usage line alone said neither).
    expect(banner).toContain('Chat with an agent in the terminal.');
    expect(banner).toContain('--target=<node-server|cloudflare-worker|docker>');
    expect(banner).not.toContain('stub');
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

describe('bin/lousho.js loads ./.env for the agent commands', () => {
  it.skipIf(!fs.existsSync(path.resolve(__dirname, '..', '..', 'dist', 'cli', 'doctor.mjs')))(
    'lousho doctor sees a key that is only in ./.env (needs npm run build)',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dotenv-'));
      try {
        fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-from-dotenv-file\n');
        const env = { ...process.env };
        delete env.OPENAI_API_KEY;
        const res = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { cwd: dir, env, encoding: 'utf8' });
        const check = (JSON.parse(res.stdout) as { checks: { id: string; status: string }[] }).checks.find((c) => c.id === 'env.openai');
        expect(check?.status).toBe('ok');
        expect(res.stdout).not.toContain('sk-from-dotenv-file');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
