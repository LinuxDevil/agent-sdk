/**
 * X06a scan rules for `findAgentDirs`/`resolveAgentDir`: BFS to depth 3,
 * the skip list, hidden dirs, symlinks, the result cap, and path-escape
 * containment (realpath on both sides).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findAgentDirs, resolveAgentDir, AGENT_DIR_LIMIT, AGENT_DIR_SCAN_DEPTH, AGENT_DIR_SKIP } from '../workspace/agentDirs';

const YAML = 'model: mock/mock-1\ninstructions: hi\n';

function write(root: string, rel: string, content = YAML): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('findAgentDirs', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x06a-dirs-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('lists data and code config dirs, skips node_modules and over-depth dirs', async () => {
    write(base, 'agents/a/agent.yaml');
    write(base, 'agents/b/agent.ts', 'export default {}\n');
    write(base, 'node_modules/x/agent.yaml');
    // A dir exactly at SCAN_DEPTH is listed; one deeper is not.
    const atDepth = Array.from({ length: AGENT_DIR_SCAN_DEPTH }, (_, i) => `d${i}`).join('/');
    const overDepth = `${atDepth}/deeper`;
    write(base, `${atDepth}/agent.yaml`);
    write(base, `${overDepth}/agent.yaml`);
    write(base, '.hidden/agent.yaml');
    write(base, 'plain/readme.txt'); // no config - not an agent dir

    const dirs = await findAgentDirs(base);
    expect(dirs.map((d) => d.path)).toEqual(['agents/a', 'agents/b', atDepth]);
    expect(dirs[0]).toMatchObject({ name: 'a', configFile: 'agent.yaml', configKind: 'data' });
    expect(dirs[1]).toMatchObject({ name: 'b', configFile: 'agent.ts', configKind: 'code' });
  });

  it('lists the workspace root itself when it holds a config', async () => {
    write(base, 'agent.json', '{}');
    write(base, 'child/agent.yaml');
    const dirs = await findAgentDirs(base);
    expect(dirs[0]).toMatchObject({ path: '.', name: path.basename(base), configFile: 'agent.json', configKind: 'data' });
    expect(dirs[1].path).toBe('child');
  });

  it('still scans inside an agent dir (subagent dirs are agent dirs too)', async () => {
    write(base, 'team/agent.yaml');
    write(base, 'team/sub/agent.yaml');
    const dirs = await findAgentDirs(base);
    expect(dirs.map((d) => d.path)).toEqual(['team', 'team/sub']);
  });

  it('skips every AGENT_DIR_SKIP name and dot dirs at any depth', async () => {
    for (const skip of AGENT_DIR_SKIP) {
      write(base, `${skip}/agent.yaml`);
    }
    write(base, 'ok/agent.yaml');
    const dirs = await findAgentDirs(base);
    expect(dirs.map((d) => d.path)).toEqual(['ok']);
  });

  it('does not follow symlinked directories', async () => {
    write(base, 'real/agent.yaml');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x06a-out-'));
    write(outside, 'agent.yaml');
    try {
      fs.symlinkSync(outside, path.join(base, 'linked'), 'junction');
    } catch {
      return; // symlink privilege unavailable (Windows without developer mode)
    }
    const dirs = await findAgentDirs(base);
    expect(dirs.map((d) => d.path)).toEqual(['real']);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('stops after AGENT_DIR_LIMIT results', async () => {
    for (let i = 0; i < AGENT_DIR_LIMIT + 5; i++) {
      write(base, `a${String(i).padStart(4, '0')}/agent.yaml`);
    }
    const dirs = await findAgentDirs(base);
    expect(dirs).toHaveLength(AGENT_DIR_LIMIT);
  }, 30000);
});

describe('resolveAgentDir', () => {
  let base: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x06a-resolve-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x06a-outside-'));
    write(base, 'agents/a/agent.yaml');
    write(base, 'plain/dir/readme.txt');
    write(outside, 'agent.yaml');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a listed agent dir to its real path', async () => {
    const abs = await resolveAgentDir(base, 'agents/a');
    expect(abs).toBe(await fs.promises.realpath(path.join(base, 'agents', 'a')));
  });

  it('rejects traversals, absolute paths and non-agent dirs', async () => {
    expect(await resolveAgentDir(base, '../outside')).toBeUndefined();
    expect(await resolveAgentDir(base, 'agents/../../outside')).toBeUndefined();
    expect(await resolveAgentDir(base, '/etc')).toBeUndefined();
    expect(await resolveAgentDir(base, 'C:\\Windows')).toBeUndefined();
    expect(await resolveAgentDir(base, 'plain/dir')).toBeUndefined(); // no config
    expect(await resolveAgentDir(base, 'missing')).toBeUndefined();
    expect(await resolveAgentDir(base, '')).toBeUndefined();
  });

  it('rejects a symlink that points outside the workspace', async () => {
    try {
      fs.symlinkSync(outside, path.join(base, 'escape'), 'junction');
    } catch {
      return;
    }
    expect(await resolveAgentDir(base, 'escape')).toBeUndefined();
  });
});
