/**
 * LOU-H4 real, end-to-end integration test: runs the CLI in a FRESH TEMP
 * DIRECTORY (os.tmpdir()+mkdtemp, never inside this worktree), then
 * actually runs `npm install && npm run build` inside the generated
 * project and asserts both succeed. This is slow (npm install downloads
 * real packages) so it's kept in its own file / a generous timeout.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

describe('end-to-end scaffold + install + build', () => {
  let dir: string | undefined;

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'generates an installable, buildable project pinned to the SDK\'s exact own version',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'create-loushy-agent-e2e-'));
      dir = path.join(base, 'test-agent');

      execFileSync(
        process.execPath,
        [CLI, '--name=test-agent', '--provider=openai', '--yes', `--dir=${dir}`],
        { encoding: 'utf8' }
      );

      expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);

      execFileSync('npm', ['install'], { cwd: dir, encoding: 'utf8', shell: true });
      const buildOutput = execFileSync('npm', ['run', 'build'], {
        cwd: dir,
        encoding: 'utf8',
        shell: true,
      });
      expect(buildOutput).toBeDefined();

      const sdkRootPkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
      );
      const installedPkg = JSON.parse(
        fs.readFileSync(
          path.join(dir, 'node_modules', '@loushy', 'build-ai-agent', 'package.json'),
          'utf8'
        )
      );

      expect(installedPkg.version).toBe(sdkRootPkg.version);
    },
    180_000
  );
});
