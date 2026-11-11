import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACES = fileURLToPath(new URL('..', import.meta.url));
const FS_IMPORT = /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;
const ALLOWED = /^(?:source\/folder[^/]*|runtime\/fileArtifactStore|runtime\/fileLedger)\.ts$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-d)?\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('R17: node:fs stays in the folder source', () => {
  it('nothing under src/workspaces/ outside source/folder* and the file stores imports node:fs', () => {
    const offenders = sourceFiles(WORKSPACES)
      .map((path) => relative(WORKSPACES, path).split('\\').join('/'))
      .filter((path) => !ALLOWED.test(path) && FS_IMPORT.test(readFileSync(join(WORKSPACES, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
