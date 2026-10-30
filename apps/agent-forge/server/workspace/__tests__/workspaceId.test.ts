import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WORKSPACE_ID_RE } from '../../../shared/workspace';
import { canonicalRoot, workspaceIdFor, workspaceRefFor, workspaceSlug } from '../workspaceId';

describe('workspaceSlug', () => {
  it('lowercases and collapses runs of non-[a-z0-9] to one dash', () => {
    expect(workspaceSlug('My Project!!')).toBe('my-project');
  });

  it("returns 'workspace' for a name with no slug content", () => {
    expect(workspaceSlug('')).toBe('workspace');
    expect(workspaceSlug('!!!')).toBe('workspace');
  });

  it('caps at 40 chars without a trailing dash', () => {
    expect(workspaceSlug('x'.repeat(80))).toBe('x'.repeat(40));
    // Char 40 being a separator must not leave a dangling '-'.
    const slug = workspaceSlug(`${'a'.repeat(39)}-${'b'.repeat(40)}`);
    expect(slug).toBe('a'.repeat(39));
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('workspaceIdFor / workspaceRefFor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w00-wsid-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('emits an id matching WORKSPACE_ID_RE', () => {
    expect(workspaceIdFor(tmp)).toMatch(WORKSPACE_ID_RE);
  });

  it('gives the same id for the same folder spelled different ways', () => {
    const a = workspaceIdFor(tmp);
    expect(workspaceIdFor(tmp + path.sep)).toBe(a);
    expect(workspaceIdFor(path.join(tmp, 'x', '..'))).toBe(a);
  });

  it('gives a non-existent folder an id anyway (resolved path, no realpath)', () => {
    const missing = path.join(tmp, 'not-there-yet');
    expect(fs.existsSync(missing)).toBe(false);
    expect(workspaceIdFor(missing)).toMatch(WORKSPACE_ID_RE);
  });

  it('gives two different folders different ids', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w00-wsid-'));
    try {
      expect(workspaceIdFor(other)).not.toBe(workspaceIdFor(tmp));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('canonicalRoot returns an absolute path for a folder that does not exist', () => {
    expect(canonicalRoot(path.join(tmp, 'missing'))).toBe(path.resolve(tmp, 'missing'));
  });

  it('workspaceRefFor stamps both dates with `now` and names the folder', () => {
    const ref = workspaceRefFor(tmp, new Date(0));
    expect(ref.addedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(ref.lastOpenedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(ref.id).toBe(workspaceIdFor(tmp));
    expect(ref.root).toBe(canonicalRoot(tmp));
    expect(ref.name).toBe(path.basename(canonicalRoot(tmp)));
  });
});
