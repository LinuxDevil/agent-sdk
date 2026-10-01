import path from 'node:path';
import { SDKError } from '../execution/errors';
import type { ErrorCode } from '../utils/errorCodes';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';

const SOURCE_FILE = /\.[cm]?[jt]s$/;
const NOT_A_SOURCE_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\./;

/**
 * Loads `<dir>/<folder>/*.{ts,js,mjs,cjs,mts}` (sorted by file name) where each
 * file default-exports one value. `isValid` guards it (else an SDKError with
 * `code` naming the file and `expectation`); `build` receives it with the file
 * name minus extension.
 */
export async function loadDefaultExports<T, R>(
  dir: string,
  folder: string,
  code: ErrorCode,
  expectation: string,
  isValid: (value: unknown) => value is T,
  build: (value: T, fileStem: string) => R
): Promise<R[]> {
  const folderDir = path.join(dir, folder);
  const files = await listSorted(folderDir, (e) => e.isFile && SOURCE_FILE.test(e.name) && !NOT_A_SOURCE_FILE.test(e.name));
  const loaded: R[] = [];
  for (const fileName of files) {
    const file = path.join(folderDir, fileName);
    const exported = (await importModule(file)).default;
    if (!isValid(exported)) throw new SDKError(`loadAgentDir: ${file}: the default export must be ${expectation}`, code);
    loaded.push(build(exported, fileName.replace(SOURCE_FILE, '')));
  }
  return loaded;
}
