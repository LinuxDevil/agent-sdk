import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

describe('cli (flag-based non-interactive shortcut)', () => {
  it('scaffolds using --name/--provider without touching the interactive prompts', () => {
    const output = execFileSync(
      process.execPath,
      [CLI, '--name=test-agent', '--provider=anthropic', '--tools=http,github', '--yes'],
      { encoding: 'utf8' }
    );

    expect(output).toContain('Scaffolding test-agent (anthropic)');
  });
});
