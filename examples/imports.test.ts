/**
 * Examples are meant to be copied into an app, so they import the SDK by its
 * package name and public subpaths, never `src/`. The repo maps those names
 * to source through tsconfig.json `paths`, which must list every export.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return /\.(ts|mts|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('example imports', () => {
  it('example sources import the SDK through public entry points, not src/', () => {
    const offenders = walk(__dirname)
      .filter((file) => !/\.test\.ts$/.test(file))
      .flatMap((file) =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => /from '(\.\.\/)+src(\/|')/.test(line))
          .map((line) => `${path.relative(REPO_ROOT, file)}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });

  it('tsconfig.json maps exactly the package exports to their sources', () => {
    const { config } = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
    const expected: Record<string, string[]> = Object.fromEntries(
      Object.entries<{ require: { types: string } }>(pkg.exports).map(([subpath, entry]) => [
        subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
        [entry.require.types.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts')],
      ])
    );
    expect(config.compilerOptions.paths).toEqual(expected);
    for (const [target] of Object.values(expected)) expect(fs.existsSync(path.join(REPO_ROOT, target))).toBe(true);
  });
});
