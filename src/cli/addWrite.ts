/**
 * The safe part of `lousho add` (LOU-D50): checks every file a registry item
 * wants to write and writes it. A path is rejected unless it is relative, free
 * of `..`, backslashes and drive letters, inside the folder its item type may
 * write to, and (after resolving symlinks) inside the agent directory.
 */
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SDKError } from '../execution/errors';
import type { RegistryItem } from './registry';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ITEM_BYTES = 1024 * 1024;

export interface PlannedFile {
  /** The path as the registry wrote it, forward slashes. */
  relative: string;
  absolute: string;
  content: string;
  /** Set by checkTargets(): a file already sits at the target path. */
  exists?: boolean;
}

function unsafe(item: RegistryItem, file: string, reason: string): SDKError {
  return new SDKError(`lousho add: '${item.name}' wants to write '${file}': ${reason}`, 'LOUSHO_REGISTRY_UNSAFE_PATH');
}

/** The folder (with a trailing slash) the item's files must live in. A `kit` is a whole agent directory, so its files may sit anywhere. */
function allowedFolder(item: RegistryItem): string {
  if (item.type === 'kit') return '';
  if (item.type === 'skill') return `skills/${item.name}/`;
  return item.type === 'memory' ? 'memory/' : `${item.type}s/`;
}

/** Why `file` is not a plain relative path inside `folder`, or undefined when it is. An empty `folder` (a kit) allows every relative path. */
function pathProblem(file: string, folder: string): string | undefined {
  if (file === '' || file.includes('\0')) return 'the path is empty or has a NUL character.';
  if (file.includes('\\')) return 'backslashes are not allowed; use "/".';
  if (/^[A-Za-z]:/.test(file)) return 'drive letters are not allowed.';
  if (file.startsWith('/')) return 'absolute paths are not allowed.';
  if (file.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return 'the path must be normalized and cannot contain "..".';
  if (folder !== '' && (!file.startsWith(folder) || file.length === folder.length)) return `it must be inside ${folder}`;
  return undefined;
}

/** Validates the item's files (paths and sizes) against `agentDir`; nothing is touched on disk. */
export function planFiles(item: RegistryItem, agentDir: string): PlannedFile[] {
  const folder = allowedFolder(item);
  let total = 0;
  return item.files.map((file) => {
    const problem = pathProblem(file.path, folder);
    if (problem) throw unsafe(item, file.path, problem);
    const bytes = Buffer.byteLength(file.content);
    total += bytes;
    if (bytes > MAX_FILE_BYTES) throw unsafe(item, file.path, `the file is larger than ${MAX_FILE_BYTES} bytes.`);
    if (total > MAX_ITEM_BYTES) throw unsafe(item, file.path, `the item is larger than ${MAX_ITEM_BYTES} bytes.`);
    return { relative: file.path, absolute: path.join(agentDir, ...file.path.split('/')), content: file.content };
  });
}

/** True when `target` is `root` or inside it. */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The real path of the nearest ancestor of `target` that exists. */
async function realAncestor(target: string): Promise<string> {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return await realpath(current);
    } catch {
      if (path.dirname(current) === current) return current;
    }
  }
}

async function lstatOrUndefined(file: string) {
  try {
    return await lstat(file);
  } catch {
    return undefined;
  }
}

/** Refuses symlink escapes and (without `overwrite`) existing files. Call before writing anything. Marks `file.exists` for the report. */
export async function checkTargets(item: RegistryItem, files: PlannedFile[], agentDir: string, overwrite: boolean): Promise<void> {
  const root = await realpath(agentDir);
  for (const file of files) {
    if (!inside(root, await realAncestor(file.absolute))) throw unsafe(item, file.relative, 'it resolves outside the agent directory (a symlink).');
    const stats = await lstatOrUndefined(file.absolute);
    file.exists = stats !== undefined;
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw unsafe(item, file.relative, 'the target is a symlink.');
    if (!overwrite) {
      throw new SDKError(`lousho add: ${file.relative} already exists.`, 'LOUSHO_REGISTRY_FILE_EXISTS', {
        hint: 'Pass --overwrite to replace it, or move your file away first.',
      });
    }
  }
}

export async function writeFiles(files: PlannedFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(path.dirname(file.absolute), { recursive: true });
    await writeFile(file.absolute, file.content, 'utf8');
  }
}
