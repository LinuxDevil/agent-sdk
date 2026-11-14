/**
 * W08a pattern scan rules for `isAgentDirPattern`/`scanAgentDirs` and the
 * `CodeAgentCache` contract: glob validation, default vs custom patterns,
 * the shared skip list, symlinked dirs, the result cap, and one-scan-per-
 * workspace concurrency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodeAgentCache,
  isAgentDirPattern,
  scanAgentDirs,
} from '../codeAgentScan';
import { AGENT_DIR_LIMIT } from '../agentDirs';
import type { WorkspaceEntry } from '../workspaceRegistry';
import { DEFAULT_AGENT_DIRS } from '../../../shared/wireTypes';

const YAML = 'model: mock/mock-1\ninstructions: hi\n';

function write(root: string, rel: string, content = YAML): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function entry(root: string, id = 'ws-test', agentDirs?: string[]): WorkspaceEntry {
  return { id, name: 'ws', root, addedAt: '', lastOpenedAt: '', ...(agentDirs ? { agentDirs } : {}) };
}

describe('isAgentDirPattern', () => {
  it.each([
    ['agents/*/', true],
    ['agents/*', true],
    ['src/agents/*/', true],
    ['tools/*/nested/', true],
    ['agents', true],
    ['.', true],
    ['', false],
    ['/', false],
    ['//agents', false],
    ['agents//x', false],
    ['../x', false],
    ['agents/../x', false],
    ['a**/x', false],
    ['**/x', false],
    ['agents/**/', false],
    ['C:/agents/*/', false],
    ['/abs/*/', false],
    ['agents/*x/', false],
    ['agents/x*/', false],
  ])('%s -> %s', (pattern, expected) => {
    expect(isAgentDirPattern(pattern)).toBe(expected);
  });
});

describe('scanAgentDirs', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w08a-scan-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('finds agent dirs under the default patterns only', async () => {
    write(base, 'agents/a/agent.yaml');
    write(base, 'src/agents/b/agent.ts', 'export default {}\n');
    write(base, 'tools/c/agent.yaml');
    write(base, 'agents/plain/readme.txt');

    const dirs = await scanAgentDirs(base, [...DEFAULT_AGENT_DIRS]);
    expect(dirs.map((d) => [d.path, d.configKind])).toEqual([
      ['agents/a', 'data'],
      ['src/agents/b', 'code'],
    ]);
    expect(dirs[0]).toMatchObject({ name: 'a', configFile: 'agent.yaml' });
    expect(dirs[1]).toMatchObject({ name: 'b', configFile: 'agent.ts' });
  });

  it('honours custom patterns, including literal segments and deeper stars', async () => {
    write(base, 'tools/c/agent.yaml');
    write(base, 'tools/d/agent.yaml');
    write(base, 'packages/x/y/agent.yaml');
    write(base, 'agents/a/agent.yaml');

    const dirs = await scanAgentDirs(base, ['tools/*/', 'packages/*/*/']);
    expect(dirs.map((d) => d.path)).toEqual(['packages/x/y', 'tools/c', 'tools/d']);
  });

  it('skips the shared skip list and hidden dirs reached through a wildcard', async () => {
    write(base, 'agents/node_modules/agent.yaml');
    write(base, 'agents/.hidden/agent.yaml');
    write(base, 'agents/ok/agent.yaml');

    const dirs = await scanAgentDirs(base, ['agents/*/']);
    expect(dirs.map((d) => d.path)).toEqual(['agents/ok']);
  });

  it('never follows a symlinked directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w08a-outside-'));
    try {
      write(outside, 'evil/agent.yaml');
      write(base, 'agents/real/agent.yaml');
      fs.symlinkSync(path.join(outside, 'evil'), path.join(base, 'agents', 'linked'), 'junction');
      const dirs = await scanAgentDirs(base, ['agents/*/']);
      expect(dirs.map((d) => d.path)).toEqual(['agents/real']);
    } catch (error) {
      // Windows without Developer Mode/SeCreateSymbolicLinkPrivilege
      // refuses symlink creation - same EPERM tolerance as the X06a tests.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('caps results at AGENT_DIR_LIMIT', async () => {
    for (let i = 0; i < AGENT_DIR_LIMIT + 5; i++) {
      write(base, `agents/a${String(i).padStart(4, '0')}/agent.yaml`);
    }
    const dirs = await scanAgentDirs(base, ['agents/*/']);
    expect(dirs).toHaveLength(AGENT_DIR_LIMIT);
    expect(dirs[0].path).toBe('agents/a0000');
    expect(dirs[dirs.length - 1].path).toBe(`agents/a${String(AGENT_DIR_LIMIT - 1).padStart(4, '0')}`);
  });
});

describe('CodeAgentCache', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w08a-cache-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('scan() always scans fresh and stores the result; get() serves the latest', async () => {
    write(base, 'agents/a/agent.yaml');
    write(base, 'tools/b/agent.yaml');
    const cache = new CodeAgentCache(() => new Date('2026-01-01T00:00:00Z'));
    const ref = entry(base);

    const first = await cache.scan(ref);
    expect(first.workspaceId).toBe('ws-test');
    expect(first.scannedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first.patterns).toEqual([...DEFAULT_AGENT_DIRS]);
    expect(first.agents.map((a) => a.path)).toEqual(['agents/a']);
    expect(cache.get('ws-test')).toBe(first);

    // scan() is always fresh: a mutated entry's agentDirs take effect and
    // the new result replaces the cached one.
    const second = await cache.scan({ ...ref, agentDirs: ['tools/*/'] });
    expect(second).not.toBe(first);
    expect(second.agents.map((a) => a.path)).toEqual(['tools/b']);
    expect(cache.get('ws-test')).toBe(second);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('uses the entry agentDirs over the defaults and shares one scan across concurrent calls', async () => {
    write(base, 'agents/a/agent.yaml');
    write(base, 'tools/b/agent.yaml');
    // `now` runs once per actual scan - concurrent cache.scan calls share
    // the in-flight promise, so it fires exactly once.
    let scans = 0;
    const cache = new CodeAgentCache(() => {
      scans += 1;
      return new Date();
    });

    const ref = entry(base, 'ws-test', ['tools/*/']);
    const [a, b] = await Promise.all([cache.scan(ref), cache.scan(ref)]);
    expect(scans).toBe(1);
    expect(a).toBe(b);
    expect(a.patterns).toEqual(['tools/*/']);
    expect(a.agents.map((d) => d.path)).toEqual(['tools/b']);
  });

  it('forget() drops the cached scan so the next scan runs fresh', async () => {
    write(base, 'agents/a/agent.yaml');
    const cache = new CodeAgentCache();
    const ref = entry(base);
    await cache.scan(ref);
    cache.forget('ws-test');
    expect(cache.get('ws-test')).toBeUndefined();
    const again = await cache.scan(ref);
    expect(again.agents.map((d) => d.path)).toEqual(['agents/a']);
  });
});
