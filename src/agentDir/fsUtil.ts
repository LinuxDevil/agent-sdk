import { promises as fs } from 'node:fs';
import { SDKError } from '../execution/errors';

/** Names directly inside `dir` that satisfy `keep`, sorted; empty when `dir` does not exist. */
export async function listSorted(
  dir: string,
  keep: (entry: { name: string; isFile: boolean; isDirectory: boolean }) => boolean
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SDKError(`loadAgentDir: cannot read directory '${dir}' (${(error as Error).message}).`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  return entries
    .filter((e) => keep({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** True when `file` exists and is a regular file. */
export async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (s) => s.isFile(),
    () => false
  );
}

/** True when `dir` exists and is a directory. */
export async function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false
  );
}

/** Reads a UTF-8 file, rethrowing failures with the path in the message. */
export async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new SDKError(`loadAgentDir: cannot read ${file} (${(error as Error).message}).`, 'LOUSHO_AGENT_DIR_INVALID');
  }
}
