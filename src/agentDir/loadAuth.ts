import path from 'node:path';
import type { AuthFn } from '../auth/types';
import { SDKError } from '../execution/errors';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';

/** `auth.ts`, `auth.js`, ... at the root of an agent directory (not tests or declarations). */
const AUTH_FILE = /^auth\.[cm]?[jt]s$/;

/**
 * N10a: the route auth of an agent directory, from its `auth.{ts,js,mjs,cjs,mts}`
 * file, which default-exports an auth entry or an ordered list of them
 * (`jwt()`, `oidc()`, `basic()`, `apiToken()`, ... from `@lousho/build-ai-agent/auth`).
 * `undefined` when the directory has no such file.
 */
export async function loadAuth(dir: string): Promise<{ file: string; auth: AuthFn | readonly AuthFn[] } | undefined> {
  const files = await listSorted(dir, (e) => e.isFile && AUTH_FILE.test(e.name));
  if (files.length === 0) return undefined;
  if (files.length > 1) {
    throw new SDKError(`loadAgentDir: ${dir} has ${files.join(' and ')}. Keep one auth file.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  const file = path.join(dir, files[0]);
  const auth = (await importModule(file)).default;
  const valid = typeof auth === 'function' || (Array.isArray(auth) && auth.every((entry) => typeof entry === 'function'));
  if (!valid) {
    throw new SDKError(
      `loadAgentDir: ${file}: the default export must be an auth function or a list of them (jwt(), oidc(), basic(), apiToken() from @lousho/build-ai-agent/auth).`,
      'LOUSHO_AGENT_DIR_INVALID'
    );
  }
  return { file, auth: auth as AuthFn | readonly AuthFn[] };
}
