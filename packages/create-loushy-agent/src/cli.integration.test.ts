import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli (flag-based non-interactive shortcut)', () => {
  it('scaffolds using --name/--provider without touching the interactive prompts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-loushy-agent-cli-'));
    tempDirs.push(dir);

    const output = execFileSync(
      process.execPath,
      [
        CLI,
        '--name=test-agent',
        '--provider=anthropic',
        '--tools=http',
        '--yes',
        `--dir=${dir}`,
      ],
      { encoding: 'utf8' }
    );

    expect(output).toContain('Scaffolding test-agent (anthropic)');
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src', 'agent.ts'))).toBe(true);
  });
});
