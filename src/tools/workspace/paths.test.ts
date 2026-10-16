import { describe, it, expect } from 'vitest';
import { createDenyTest, normalizeAllowedPath, normalizeWorkspacePath, WorkspaceError } from './paths';
import { globToRegExp } from './glob';

describe('normalizeWorkspacePath (LOU-X6)', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src//a.ts', 'src/a.ts'],
    ['src/x/../a.ts', 'src/a.ts'],
    ['src\\a.ts', 'src/a.ts'],
    ['.', '.'],
    ['', '.'],
    ['./', '.'],
    ['a/..', '.'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeWorkspacePath(input, 'linux')).toBe(expected);
  });

  it.each([
    ['../secret', /climbs above/],
    ['a/../../secret', /climbs above/],
    ['..\\..\\Windows', /climbs above/],
    ['a/..\\..\\b', /climbs above/],
    ['/etc/passwd', /absolute/],
    ['\\\\server\\share\\x', /absolute and UNC/],
    ['//server/share', /absolute and UNC/],
    ['\\\\?\\C:\\x', /absolute and UNC/],
    ['C:\\Windows\\win.ini', /drive-letter/],
    ['c:/x', /drive-letter/],
    ['C:relative', /drive-letter/],
    ['a\0b', /NUL/],
  ])('rejects %j on every platform', (input, reason) => {
    for (const platform of ['linux', 'win32']) {
      expect(() => normalizeWorkspacePath(input, platform)).toThrow(WorkspaceError);
      expect(() => normalizeWorkspacePath(input, platform)).toThrow(reason);
    }
  });

  it('rejects Windows-only hazards on win32 and allows them elsewhere', () => {
    expect(() => normalizeWorkspacePath('file.txt:stream', 'win32')).toThrow(/alternate data streams/);
    expect(() => normalizeWorkspacePath('NUL', 'win32')).toThrow(/reserved Windows device/);
    expect(() => normalizeWorkspacePath('dir/con.txt', 'win32')).toThrow(/reserved Windows device/);
    expect(() => normalizeWorkspacePath('.. /x', 'win32')).toThrow(/dots and spaces/);
    expect(() => normalizeWorkspacePath('a/... ', 'win32')).toThrow(/dots and spaces/);
    expect(normalizeWorkspacePath('file.txt:stream', 'linux')).toBe('file.txt:stream');
    expect(normalizeWorkspacePath('NUL', 'linux')).toBe('NUL');
  });

  it('names the path and how to fix it', () => {
    expect(() => normalizeWorkspacePath('../x', 'linux')).toThrow(
      'Path "../x" is outside the workspace (\'..\' climbs above the workspace root). Use a path relative to the workspace root, e.g. "src/index.ts".'
    );
  });

  it('rejects non-string paths', () => {
    expect(() => normalizeWorkspacePath(42 as unknown as string)).toThrow(/must be a string/);
  });
});

describe('globToRegExp (LOU-X6)', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['src/**', 'src/a/b.c', true],
    ['src/**/test/*.ts', 'src/test/a.ts', true],
    ['src/**/test/*.ts', 'src/x/y/test/a.ts', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['*.{js,jsx}', 'x.jsx', true],
    ['*.{js,jsx}', 'x.ts', false],
    ['[ab].txt', 'b.txt', true],
    ['[!ab].txt', 'b.txt', false],
    ['file(1).txt', 'file(1).txt', true],
    ['a+b.txt', 'aab.txt', false],
    ['x}.txt', 'x}.txt', true],
    ['[unclosed', '[unclosed', true],
  ])('%j vs %j -> %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });

  it('rejects an unclosed brace with a clear error', () => {
    expect(() => globToRegExp('*.{js')).toThrow(/unclosed '\{'/);
  });
});

describe('createDenyTest (consumer harness H1-2)', () => {
  it.each([
    ['.git', '.git'],
    ['.git/config', '.git'],
    ['a/.git/HEAD', '.git'],
    ['.GIT/config', '.GIT'],
    ['.Git', '.Git'],
    ['.git./config', '.git.'],
    ['.git /config', '.git '],
  ])('denies %j (segment %j) on every platform', (path, segment) => {
    expect(createDenyTest(['.git'], 'linux')(path)).toBe(segment);
    expect(createDenyTest(['.git'], 'win32')(path)).toBe(segment);
  });

  it.each(['.', 'src/a.ts', '.gitignore', '.github/x', 'my.git/x', 'git/x'])('allows %j', (path) => {
    expect(createDenyTest(['.git'], 'win32')(path)).toBeUndefined();
  });

  it('denies 8.3 short-name aliases on Windows only', () => {
    for (const alias of ['GIT~1/config', 'git~2', 'GI4F2A~1/HEAD']) {
      expect(createDenyTest(['.git'], 'win32')(alias)).toBeDefined();
      expect(createDenyTest(['.git'], 'linux')(alias)).toBeUndefined();
    }
  });

  it('denies nothing for an empty list', () => {
    expect(createDenyTest([], 'win32')('.git/config')).toBeUndefined();
  });

  it('normalizeAllowedPath normalizes first, so ./, .. and backslashes cannot hide a denied segment', () => {
    const isDenied = createDenyTest(['.git'], 'linux');
    for (const path of ['./.git/config', 'a/../.git/config', '.git\\config', '.git/', 'x\\..\\.git']) {
      expect(() => normalizeAllowedPath(path, isDenied)).toThrow(WorkspaceError);
    }
    expect(normalizeAllowedPath('./src//a.ts', isDenied)).toBe('src/a.ts');
  });
});
