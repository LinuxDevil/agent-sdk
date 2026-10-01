/**
 * Project instructions (LOU-W7): find the nearest AGENTS.md / CLAUDE.md so an
 * agent can follow a repository's own conventions.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Options for {@link loadProjectInstructions}. */
export interface LoadProjectInstructionsOptions {
  /** Directory to start from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** File names to look for in each directory, first match wins. Defaults to `['AGENTS.md', 'CLAUDE.md']`. */
  files?: readonly string[];
  /** Last directory to look in (inclusive). Defaults to the nearest directory containing `.git`, else the filesystem root. */
  stopAt?: string;
  /** Longest content to return, in characters; longer files are cut with a marker. Defaults to 32000. */
  maxChars?: number;
}

/** A project instructions file that was found. */
export interface ProjectInstructions {
  /** Absolute path of the file. */
  path: string;
  /** Its text, truncated (with a marker) beyond `maxChars`. */
  content: string;
}

const DEFAULT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const DEFAULT_MAX_CHARS = 32_000;

function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function findInDirectory(dir: string, files: readonly string[]): ProjectInstructions | undefined {
  for (const name of files) {
    const path = join(dir, name);
    const content = readIfFile(path);
    if (content !== undefined && content.trim() !== '') return { path, content };
  }
  return undefined;
}

function truncate(found: ProjectInstructions, maxChars: number): ProjectInstructions {
  if (found.content.length <= maxChars) return found;
  const marker = `\n\n[... truncated: file is longer than ${maxChars} characters ...]`;
  return { path: found.path, content: found.content.slice(0, maxChars) + marker };
}

/**
 * Find the project instructions file: walk up from `cwd`, and in the nearest
 * directory that has one of `files` return the first match. The walk ends at
 * `stopAt`, at the first directory containing `.git`, or at the filesystem
 * root. Returns `undefined` when there is none. Reads files synchronously.
 *
 * @example
 * ```ts
 * const found = loadProjectInstructions({ cwd: process.cwd() });
 * if (found) console.log(found.path);
 * ```
 */
export function loadProjectInstructions(
  options: LoadProjectInstructionsOptions = {}
): ProjectInstructions | undefined {
  const files = options.files ?? DEFAULT_FILES;
  const stop = options.stopAt === undefined ? undefined : resolve(options.stopAt);
  let dir = resolve(options.cwd ?? process.cwd());
  for (;;) {
    const found = findInDirectory(dir, files);
    if (found) return truncate(found, options.maxChars ?? DEFAULT_MAX_CHARS);
    const parent = dirname(dir);
    if (dir === stop || existsSync(join(dir, '.git')) || parent === dir) return undefined;
    dir = parent;
  }
}
