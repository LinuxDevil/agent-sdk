/**
 * Glob matching and tree walking over any FsProvider (LOU-X6).
 */
import type { FsProvider } from './types';
import { joinWorkspacePath, WorkspaceError } from './paths';

const REGEX_SPECIAL = /[.+^$()|\\/]/;

/** Translates a `[...]` character class starting at `pattern[start]`; returns [regex, nextIndex]. */
function translateClass(pattern: string, start: number): [string, number] {
  const end = pattern.indexOf(']', start + 2);
  if (end === -1) return ['\\[', start + 1];
  let body = pattern.slice(start + 1, end).replace(/\\/g, '\\\\');
  if (body.startsWith('!')) body = `^${body.slice(1)}`;
  return [`[${body}]`, end + 1];
}

/** Translates `*` / `**` at `pattern[i]`; returns [regex, nextIndex]. */
function translateStar(pattern: string, i: number): [string, number] {
  if (pattern[i + 1] !== '*') return ['[^/]*', i + 1];
  const atSegmentStart = i === 0 || pattern[i - 1] === '/';
  if (atSegmentStart && pattern[i + 2] === '/') return ['(?:.*/)?', i + 3];
  if (atSegmentStart && i + 2 === pattern.length) return ['.*', i + 2];
  return ['[^/]*', i + 2];
}

/** Translates one glob token at `pattern[i]`, tracking `{a,b}` nesting in `braces`. */
function translateToken(pattern: string, i: number, braces: { depth: number }): [string, number] {
  const ch = pattern[i];
  if (ch === '*') return translateStar(pattern, i);
  if (ch === '?') return ['[^/]', i + 1];
  if (ch === '[') return translateClass(pattern, i);
  if (ch === '{') {
    braces.depth++;
    return ['(?:', i + 1];
  }
  if (ch === '}' && braces.depth > 0) {
    braces.depth--;
    return [')', i + 1];
  }
  if (ch === ',' && braces.depth > 0) return ['|', i + 1];
  return [REGEX_SPECIAL.test(ch) || ch === '}' ? `\\${ch}` : ch, i + 1];
}

/**
 * Compiles a glob to an anchored RegExp over `/`-separated relative paths.
 * Supports `*` (within a segment), `**` (any number of segments), `?`,
 * `[abc]` / `[!abc]` and `{a,b}`. Dotfiles are matched like any other name.
 *
 * @example
 * ```ts
 * globToRegExp('src/**\/*.ts').test('src/a/b.ts'); // true
 * ```
 */
export function globToRegExp(pattern: string): RegExp {
  const braces = { depth: 0 };
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const [piece, next] = translateToken(pattern, i, braces);
    source += piece;
    i = next;
  }
  if (braces.depth > 0) {
    throw new WorkspaceError(`Invalid glob ${JSON.stringify(pattern)}: unclosed '{'.`);
  }
  return new RegExp(`^${source}$`);
}

/** Options for {@link walkFiles}. */
interface WalkOptions {
  /** Directory names that are never descended into (e.g. `.git`). */
  ignore: ReadonlySet<string>;
  /** Stop after collecting this many files. */
  maxFiles: number;
  signal?: AbortSignal;
}

/** Result of {@link walkFiles}. */
interface WalkResult {
  files: string[];
  /** True when the walk stopped at `maxFiles`. */
  truncated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WorkspaceError('The operation was cancelled.');
}

/**
 * Lists every regular file under `base` (breadth-first, workspace-relative),
 * skipping ignored directory names. Symlinks are never followed, so a walk
 * cannot leave the workspace through a link.
 */
export async function walkFiles(fs: FsProvider, base: string, options: WalkOptions): Promise<WalkResult> {
  const files: string[] = [];
  const queue = [base];
  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = joinWorkspacePath(dir, entry.name);
      if (entry.type === 'directory' && !options.ignore.has(entry.name)) queue.push(path);
      if (entry.type !== 'file') continue;
      files.push(path);
      if (files.length >= options.maxFiles) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}
