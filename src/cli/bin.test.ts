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
  it.each(['--version', '-v', 'version'])('prints the package version for %s', (flag) => {
    const res = lousho(flag);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(VERSION);
  });

  it('keeps the top-level usage in step with the commands', () => {
    const banner = lousho('--help').stdout;
    expect(banner).toContain('lousho doctor [agent.yaml|json|agent-dir|agent.ts] [--json] [--ping]');
    // One-line descriptions and the build targets (a usage line alone said neither).
    expect(banner).toContain('Chat with an agent in the terminal.');
    expect(banner).toContain('--target=<node-server|cloudflare-worker|docker>');
    expect(banner).not.toContain('stub');
    expect(banner).toContain('[--timeout <ms>]');
    expect(banner).toContain('lousho --version');
    expect(banner).toContain('[--allowed-hosts a,b]');
    expect(banner).toContain('2 usage error');
  });

  it('exits 2 for `version` with an argument instead of ignoring it', () => {
    const res = lousho('version', 'extra');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("'version' takes no arguments; got 'extra'");
  });

  it('`help <unknown>` is an unknown command', () => {
    expect(lousho('help', 'bogus').status).toBe(2);
  });

  it.skipIf(!fs.existsSync(path.resolve(__dirname, '..', '..', 'dist', 'cli', 'traces.mjs')))(
    '`help <command>` prints that command\'s help, as `<command> --help` does (needs npm run build)',
    () => {
      const res = lousho('help', 'traces');
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(lousho('traces', '--help').stdout);
      expect(res.stdout).toContain('lousho traces');
    }
  );

  it('exits 2 for an unknown command, like every command does for a usage error', () => {
    const res = lousho('bogus');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("unknown command 'bogus'");
  });
});

describe('detectTarget command name', () => {
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

  it.skipIf(!fs.existsSync(path.resolve(__dirname, '..', '..', 'dist', 'cli', 'doctor.mjs')))(
    'keeps the first key of a .env saved with a byte order mark, and a variable already set wins (needs npm run build)',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dotenv-bom-'));
      try {
        // What PowerShell 5.1's `Set-Content -Encoding utf8` writes.
        fs.writeFileSync(path.join(dir, '.env'), String.fromCharCode(0xfeff) + 'OPENAI_API_KEY=sk-from-dotenv-file\nANTHROPIC_API_KEY=from-file\n');
        const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: '' };
        delete env.OPENAI_API_KEY;
        const res = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { cwd: dir, env, encoding: 'utf8' });
        const checks = (JSON.parse(res.stdout) as { checks: { id: string; status: string }[] }).checks;
        expect(checks.find((c) => c.id === 'env.openai')?.status).toBe('ok');
        // Set (even to empty) in the environment: the file does not override it.
        expect(checks.find((c) => c.id === 'env.anthropic')?.status).toBe('warn');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
