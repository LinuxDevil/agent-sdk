/**
 * Filesystem side of `loushy init`: name derivation, the non-empty-directory
 * guard, and writing the rendered files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InitUsageError } from './options';

/** A valid, lowercase npm package name derived from a directory's base name. */
export function packageNameFor(dir: string): string {
  const slug = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|-+$/g, '');
  return slug || 'my-agent';
}

/** Throws a clear error when `dir` exists and has files in it, unless `force`. */
export function assertWritable(dir: string, force: boolean): void {
  if (force || !fs.existsSync(dir)) return;
  if (!fs.statSync(dir).isDirectory()) {
    throw new InitUsageError(`loushy init: '${dir}' exists and is not a directory. Choose another name.`);
  }
  const entries = fs.readdirSync(dir);
  if (entries.length > 0) {
    throw new InitUsageError(
      `loushy init: '${dir}' is not empty (${entries.slice(0, 3).join(', ')}${entries.length > 3 ? ', ...' : ''}). ` +
        'Choose an empty or new directory, or pass --force to write into it anyway (existing files with the same names are overwritten).'
    );
  }
}

/** Writes `files` (paths relative to `dir`) under `dir`, creating directories as needed. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}
