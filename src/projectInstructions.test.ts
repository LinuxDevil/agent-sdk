/**
 * LOU-W7: AGENTS.md / CLAUDE.md auto-loading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions } from './projectInstructions';
import { createAgent } from './createAgent';
import { mockModel } from './testing';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'proj-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content = 'x'): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('loadProjectInstructions', () => {
  it('finds the nearest directory that has a file, walking up', () => {
    put('.git/HEAD');
    put('AGENTS.md', 'root rules');
    const pkg = put('packages/api/AGENTS.md', 'api rules');
    mkdirSync(join(root, 'packages/api/src/deep'), { recursive: true });

    const found = loadProjectInstructions({ cwd: join(root, 'packages/api/src/deep') });

    expect(found).toEqual({ path: pkg, content: 'api rules' });
  });

  it('prefers AGENTS.md over CLAUDE.md in the same directory, and honours `files` order', () => {
    put('.git/HEAD');
    put('AGENTS.md', 'agents');
    put('CLAUDE.md', 'claude');
    expect(loadProjectInstructions({ cwd: root })?.content).toBe('agents');
    expect(loadProjectInstructions({ cwd: root, files: ['CLAUDE.md', 'AGENTS.md'] })?.content).toBe('claude');
    expect(loadProjectInstructions({ cwd: root, files: ['CLAUDE.md'] })?.content).toBe('claude');
  });

  it('stops at the directory containing .git', () => {
    put('AGENTS.md', 'outside the repo');
    put('repo/.git/HEAD');
    mkdirSync(join(root, 'repo/src'), { recursive: true });
    expect(loadProjectInstructions({ cwd: join(root, 'repo/src') })).toBeUndefined();
  });

  it('checks the repo root itself and accepts a .git file (worktree)', () => {
    put('repo/.git', 'gitdir: elsewhere');
    const file = put('repo/AGENTS.md', 'in repo root');
    expect(loadProjectInstructions({ cwd: join(root, 'repo') })?.path).toBe(file);
  });

  it('stops at `stopAt` (inclusive)', () => {
    put('AGENTS.md', 'top');
    mkdirSync(join(root, 'a/b/c'), { recursive: true });
    expect(loadProjectInstructions({ cwd: join(root, 'a/b/c'), stopAt: join(root, 'a/b') })).toBeUndefined();
    put('a/b/AGENTS.md', 'at stop');
    expect(loadProjectInstructions({ cwd: join(root, 'a/b/c'), stopAt: join(root, 'a/b') })?.content).toBe(
      'at stop'
    );
  });

  it('truncates long files with a marker', () => {
    put('.git/HEAD');
    put('AGENTS.md', 'a'.repeat(100));
    const found = loadProjectInstructions({ cwd: root, maxChars: 10 });
    expect(found?.content.startsWith('a'.repeat(10))).toBe(true);
    expect(found?.content).toContain('[... truncated');
    expect(found?.content).not.toContain('a'.repeat(11));
    expect(loadProjectInstructions({ cwd: root })?.content).toBe('a'.repeat(100));
  });

  it('returns undefined when there is no file (and skips empty files and directories)', () => {
    put('.git/HEAD');
    put('AGENTS.md', '   \n');
    mkdirSync(join(root, 'CLAUDE.md'));
    expect(loadProjectInstructions({ cwd: root })).toBeUndefined();
  });
});

describe('createAgent({ projectInstructions })', () => {
  it('is off by default', async () => {
    put('.git/HEAD');
    put('AGENTS.md', 'use tabs');
    const model = mockModel(['ok']);
    await createAgent({ instructions: 'Be brief.', provider: model }).send('hi');
    expect(model.calls[0].messages[0].content).toBe('Be brief.');
  });

  it('appends the file under a heading after the agent instructions', async () => {
    put('.git/HEAD');
    put('CLAUDE.md', 'use tabs');
    const model = mockModel(['ok']);
    const agent = createAgent({
      instructions: 'Be brief.',
      provider: model,
      projectInstructions: { cwd: root },
    });
    await agent.send('hi');
    expect(model.calls[0].messages[0].content).toBe(
      'Be brief.\n\n## Project instructions (from CLAUDE.md)\n\nuse tabs'
    );
  });

  it('`true` uses process.cwd() and leaves instructions alone when nothing is found', async () => {
    put('.git/HEAD');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const model = mockModel(['ok']);
    await createAgent({ instructions: 'Be brief.', provider: model, projectInstructions: true }).send('hi');
    expect(model.calls[0].messages[0].content).toBe('Be brief.');
  });
});
