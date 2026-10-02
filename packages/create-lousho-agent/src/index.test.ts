import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loushoBin } from './index';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-lousho-agent-'));
  tempDirs.push(dir);
  return dir;
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

describe('create-lousho-agent wraps lousho init', () => {
  it('finds the lousho bin of the installed SDK', () => {
    expect(fs.existsSync(loushoBin())).toBe(true);
    expect(path.basename(loushoBin())).toBe('lousho.js');
  });

  it('forwards its arguments to lousho init (--help)', () => {
    expect(run(['--help'])).toContain('Usage: lousho init');
  });

  it('scaffolds a project from the positional directory and flags', () => {
    const base = tempDir();
    const tarball = path.join(base, 'sdk-0.0.0.tgz');
    fs.writeFileSync(tarball, 'tgz');
    const dir = path.join(base, 'demo');

    const output = run([dir, '--yes', '--provider', 'anthropic', '--no-install', '--no-git', '--sdk-path', tarball]);

    expect(output).toContain('Next steps:');
    expect(fs.readFileSync(path.join(dir, '.env.example'), 'utf8')).toContain('ANTHROPIC_API_KEY=');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies['@lousho/build-ai-agent']).toBe(
      'file:./sdk-0.0.0.tgz'
    );
  });

  it('exits non-zero with the init error for a bad flag', () => {
    expect(() => run(['--provider', 'gemini'])).toThrow(/invalid --provider 'gemini'/);
  });
});
