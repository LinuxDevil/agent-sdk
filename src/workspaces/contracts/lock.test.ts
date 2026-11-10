import { describe, it, expect } from 'vitest';
import { workspaceLockSchema, checkLock, type WorkspaceLock, type LockRef } from './lock';
import { workspaceManifestSchema, type WorkspaceManifest } from './workspace';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const manifest: WorkspaceManifest = workspaceManifestSchema.parse({
  schema: 'lousho.workspace/1',
  id: 'acme',
  name: 'Acme',
  version: '1.0.0',
  description: 'Acme workspace',
  mainAgent: null,
  pages: ['home'],
  dependencies: { agents: { 'global:copy-editor': '^1.2.0' }, profiles: { 'global:social-post': '~2.0.0' } },
});

const lock: WorkspaceLock = {
  schema: 'lousho.lock/1',
  workspace: { id: 'acme', version: '1.0.0' },
  resolved: {
    'global:copy-editor': { version: '1.2.5', sha256: SHA_A, source: 'project' },
    'global:social-post': { version: '2.0.3', sha256: SHA_B, source: 'vendor' },
  },
  generatedAt: '2026-01-01T00:00:00.000Z',
};

const refs: LockRef[] = [
  { ref: 'global:copy-editor@^1.2.0', sha256: SHA_A },
  { ref: 'global:social-post@~2.0.0', sha256: SHA_B },
  { ref: 'workspace:writer' },
  { ref: 'local:helper' },
];

function withEntry(key: string, entry: WorkspaceLock['resolved'][string]): WorkspaceLock {
  return { ...lock, resolved: { ...lock.resolved, [key]: entry } };
}

describe('workspaceLockSchema', () => {
  it('accepts a valid lock', () => {
    expect(workspaceLockSchema.safeParse(lock).success).toBe(true);
  });

  it('workspace: refs never appear in the lock', () => {
    for (const key of ['workspace:writer', 'local:helper', 'copy-editor']) {
      const result = workspaceLockSchema.safeParse(withEntry(key, { version: '1.0.0', sha256: SHA_A, source: 'project' }));
      expect(result.success, key).toBe(false);
    }
  });

  it('rejects a malformed entry and unknown keys', () => {
    expect(workspaceLockSchema.safeParse({ ...lock, extra: 1 }).success).toBe(false);
    const bad = { ...lock, resolved: { 'global:copy-editor': { version: '^1.0.0', sha256: 'zz', source: 'cloud' } } };
    const result = workspaceLockSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['resolved.global:copy-editor.version', 'resolved.global:copy-editor.sha256', 'resolved.global:copy-editor.source']));
    }
  });
});

describe('checkLock', () => {
  it('passes cleanly when the lock matches', () => {
    for (const mode of ['dev', 'strict'] as const) {
      expect(checkLock(manifest, refs, lock, mode)).toEqual({ ok: true, errors: [], warnings: [] });
    }
  });

  it('strict mode fails on a hash mismatch', () => {
    const result = checkLock(manifest, [{ ref: 'global:copy-editor@^1.2.0', sha256: SHA_B }], lock, 'strict');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('hash mismatch');
  });

  it('dev mode warns on drift', () => {
    const drifted = withEntry('global:copy-editor', { version: '1.2.5', sha256: SHA_B, source: 'project' });
    const result = checkLock(manifest, refs, drifted, 'dev');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('a pinned version outside the range is an error', () => {
    const outside = withEntry('global:copy-editor', { version: '2.0.0', sha256: SHA_A, source: 'project' });
    const strict = checkLock(manifest, refs, outside, 'strict');
    expect(strict.ok).toBe(false);
    expect(strict.errors.join('\n')).toContain("'global:copy-editor' is pinned to 2.0.0");
    expect(checkLock(manifest, refs, outside, 'dev').ok).toBe(true);
  });

  it('strict mode fails on a missing entry or missing lock; dev warns', () => {
    const partial = { ...lock, resolved: { 'global:copy-editor': lock.resolved['global:copy-editor'] } };
    expect(checkLock(manifest, refs, partial, 'strict').ok).toBe(false);
    expect(checkLock(manifest, refs, partial, 'dev').warnings.length).toBeGreaterThan(0);
    expect(checkLock(manifest, refs, undefined, 'strict').ok).toBe(false);
    const missing = checkLock(manifest, refs, undefined, 'dev');
    expect(missing.ok).toBe(true);
    expect(missing.warnings.length).toBeGreaterThan(0);
  });

  it('flags a lock for a different workspace', () => {
    const other = { ...lock, workspace: { id: 'other', version: '1.0.0' } };
    expect(checkLock(manifest, refs, other, 'strict').ok).toBe(false);
    expect(checkLock(manifest, refs, other, 'dev').warnings.length).toBeGreaterThan(0);
  });

  it('never requires workspace: or local: refs in the lock', () => {
    const bare = workspaceManifestSchema.parse({ ...manifest, dependencies: undefined });
    const result = checkLock(bare, [{ ref: 'workspace:writer' }, { ref: 'local:helper' }], { ...lock, resolved: {} }, 'strict');
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('reports an unparseable ref', () => {
    expect(checkLock(manifest, [{ ref: 'bogus' }], lock, 'strict').ok).toBe(false);
  });
});
