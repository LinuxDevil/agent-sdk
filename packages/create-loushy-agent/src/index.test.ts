import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loushyBin } from './index';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-loushy-agent-'));
  tempDirs.push(dir);
  return dir;
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

describe('create-loushy-agent wraps loushy init', () => {
  it('finds the loushy bin of the installed SDK', () => {
    expect(fs.existsSync(loushyBin())).toBe(true);
    expect(path.basename(loushyBin())).toBe('loushy.js');
  });

  it('forwards its arguments to loushy init (--help)', () => {
    expect(run(['--help'])).toContain('Usage: loushy init');
  });

  it('scaffolds a project from the positional directory and flags', () => {
    const base = tempDir();
    const tarball = path.join(base, 'sdk-0.0.0.tgz');
    fs.writeFileSync(tarball, 'tgz');
    const dir = path.join(base, 'demo');

    const output = run([dir, '--yes', '--provider', 'anthropic', '--no-install', '--no-git', '--sdk-path', tarball]);

    expect(output).toContain('Next steps:');
    expect(fs.readFileSync(path.join(dir, '.env.example'), 'utf8')).toContain('ANTHROPIC_API_KEY=');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies['@loushy/build-ai-agent']).toBe(
      'file:./sdk-0.0.0.tgz'
    );
  });

  it('exits non-zero with the init error for a bad flag', () => {
    expect(() => run(['--provider', 'gemini'])).toThrow(/invalid --provider 'gemini'/);
  });
});
