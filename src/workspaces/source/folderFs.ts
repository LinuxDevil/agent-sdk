import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { withFileLock } from '../../storage/fileLock';
import { invalidPath, sourceLimit } from './errors';
import { checkPath } from './revision';

const TEMP_SUFFIX = '.lousho-tmp';

export interface FolderLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTreeBytes: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

async function missingAsUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

function inside(root: string, real: string): boolean {
  const rel = relative(root, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function realRoot(dir: string): Promise<string> {
  const root = await missingAsUndefined(realpath(dir));
  const info = root === undefined ? undefined : await stat(root);
  if (root === undefined || !info?.isDirectory()) throw invalidPath(dir, 'is not a folder');
  return root;
}

async function resolveInside(root: string, rel: string): Promise<string | undefined> {
  const real = await missingAsUndefined(realpath(join(root, rel)));
  if (real !== undefined && !inside(root, real)) throw invalidPath(rel, 'resolves outside the workspace folder');
  return real;
}

async function readBounded(handle: FileHandle, max: number, rel: string): Promise<string> {
  const buffer = Buffer.allocUnsafe(max + 1);
  let length = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    length += bytesRead;
    if (length > max) throw sourceLimit(`'${rel}' is larger than ${max} bytes`);
    if (bytesRead === 0) return buffer.toString('utf8', 0, length);
  }
}

export async function readText(root: string, rel: string, maxBytes: number): Promise<string | undefined> {
  const real = await resolveInside(root, rel);
  const info = real === undefined ? undefined : await stat(real);
  if (real === undefined || !info?.isFile()) return undefined;
  if (info.size > maxBytes) throw sourceLimit(`'${rel}' is larger than ${maxBytes} bytes`);
  const handle = await open(real, 'r');
  try {
    return await readBounded(handle, maxBytes, rel);
  } finally {
    await handle.close();
  }
}

async function linkKind(root: string, rel: string): Promise<'file' | 'skip'> {
  try {
    const real = await resolveInside(root, rel);
    const info: Stats | undefined = real === undefined ? undefined : await stat(real);
    return info?.isFile() ? 'file' : 'skip';
  } catch {
    return 'skip';
  }
}

function listable(rel: string, name: string): boolean {
  if (name.endsWith(TEMP_SUFFIX)) return false;
  try {
    checkPath(rel);
    return true;
  } catch {
    return false;
  }
}

async function entryKind(root: string, rel: string, entry: Dirent): Promise<'dir' | 'file' | 'skip'> {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return entry.isSymbolicLink() ? linkKind(root, rel) : 'skip';
}

async function walkDir(root: string, prefix: string, out: string[], limits: FolderLimits): Promise<void> {
  const entries = await readdir(prefix === '' ? root : join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (!listable(rel, entry.name)) continue;
    const kind = await entryKind(root, rel, entry);
    if (kind === 'dir') await walkDir(root, rel, out, limits);
    if (kind === 'file') out.push(rel);
    if (out.length > limits.maxFiles) throw sourceLimit(`the folder has more than ${limits.maxFiles} files`);
  }
}

export async function readFolderTree(root: string, limits: FolderLimits): Promise<Map<string, string>> {
  const paths: string[] = [];
  await walkDir(root, '', paths, limits);
  const files = new Map<string, string>();
  let total = 0;
  for (const path of paths.sort()) {
    const text = await readText(root, path, limits.maxFileBytes);
    if (text === undefined) continue;
    total += Buffer.byteLength(text, 'utf8');
    if (total > limits.maxTreeBytes) throw sourceLimit(`the folder holds more than ${limits.maxTreeBytes} bytes`);
    files.set(path, text);
  }
  return files;
}

async function ensureFolders(root: string, rel: string, create: boolean): Promise<boolean> {
  let current = root;
  for (const segment of rel.split('/').slice(0, -1)) {
    current = join(current, segment);
    const info = await missingAsUndefined(lstat(current));
    if (info === undefined && !create) return false;
    if (info === undefined) await mkdir(current);
    else if (!info.isDirectory()) throw invalidPath(rel, `goes through '${segment}', which is not a real folder`);
  }
  return true;
}

async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await open(folder, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

async function durableTemp(target: string, content: string): Promise<string> {
  const temp = `${target}.${randomUUID()}${TEMP_SUFFIX}`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

export async function checkWritable(root: string, rel: string): Promise<void> {
  await ensureFolders(root, rel, false);
  const info = await missingAsUndefined(lstat(join(root, rel)));
  if (info?.isDirectory()) throw invalidPath(rel, 'is a folder, not a file');
}

export async function withFolderLock<T>(root: string, rel: string, task: () => Promise<T>): Promise<T> {
  await ensureFolders(root, rel, true);
  return withFileLock(join(root, rel), task, { busyCode: 'LOUSHO_STORAGE_BUSY' });
}

export async function moveAside(root: string, rel: string, to: string): Promise<void> {
  if (await ensureFolders(root, to, false)) await rename(join(root, rel), join(root, to));
}

export async function writeAtomic(root: string, rel: string, content: string): Promise<void> {
  await ensureFolders(root, rel, true);
  const target = join(root, rel);
  const temp = await durableTemp(target, content);
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncFolder(dirname(target));
}

export async function removeFile(root: string, rel: string): Promise<void> {
  if (!(await ensureFolders(root, rel, false))) return;
  await rm(join(root, rel), { force: true });
  await syncFolder(dirname(join(root, rel)));
}
