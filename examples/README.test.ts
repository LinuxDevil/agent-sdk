/**
 * LOU-H11: verifies examples/README.md's `## [dirname](./dirname)`
 * headings exactly match the actual directory listing under examples/ -
 * no stale, no missing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const EXAMPLES_DIR = __dirname;

describe('examples/README.md gallery index', () => {
  it('has exactly one heading per example directory, and no stale entries', () => {
    const dirs = fs
      .readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const readme = fs.readFileSync(path.join(EXAMPLES_DIR, 'README.md'), 'utf8');
    const headings = [...readme.matchAll(/^## \[([^\]]+)\]\(\.\/([^)]+)\)/gm)]
      .map((m) => m[2])
      .sort();

    expect(headings).toEqual(dirs);
  });
});
