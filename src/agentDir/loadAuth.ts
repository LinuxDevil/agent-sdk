import path from 'node:path';
import type { AuthFn } from '../auth/types';
import type { ChatRoutesAccess } from '../server/fetchRoutes';
import { SDKError } from '../execution/errors';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';

/** `auth.ts`, `auth.js`, ... at the root of an agent directory (not tests or declarations). */
const AUTH_FILE = /^auth\.[cm]?[jt]s$/;

/** The named exports of an auth file that become the route's session and approval rules. */
const ACCESS_RULES = ['authorizeSession', 'authorizeApproval'] as const;

/** Who may use a session and who may decide an approval, as an agent directory's auth file exports them. */
type AgentDirAccessRules = Pick<ChatRoutesAccess, 'authorizeSession' | 'authorizeApproval'>;

/**
 * The route auth of an agent directory, from its `auth.{ts,js,mjs,cjs,mts}`
 * file, which default-exports an auth entry or an ordered list of them
 * (`jwt()`, `oidc()`, `basic()`, `apiToken()`, ... from `lousho/auth`),
 * plus its optional named `authorizeSession` / `authorizeApproval` exports
 * (docs/auth.md). `undefined` when the directory has no such file.
 */
export async function loadAuth(dir: string): Promise<({ file: string; auth: AuthFn | readonly AuthFn[] } & AgentDirAccessRules) | undefined> {
  const files = await listSorted(dir, (e) => e.isFile && AUTH_FILE.test(e.name));
  if (files.length === 0) return undefined;
  if (files.length > 1) {
    throw new SDKError(`loadAgentDir: ${dir} has ${files.join(' and ')}. Keep one auth file.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  const file = path.join(dir, files[0]);
  const exports = await importModule(file);
  const auth = exports.default;
  const valid = typeof auth === 'function' || (Array.isArray(auth) && auth.every((entry) => typeof entry === 'function'));
  if (!valid) {
    throw new SDKError(
      `loadAgentDir: ${file}: the default export must be an auth function or a list of them (jwt(), oidc(), basic(), apiToken() from lousho/auth).`,
      'LOUSHO_AGENT_DIR_INVALID'
    );
  }
  const rules: AgentDirAccessRules = {};
  for (const name of ACCESS_RULES) {
    const rule = exports[name];
    if (rule === undefined) continue;
    if (typeof rule !== 'function') {
      throw new SDKError(`loadAgentDir: ${file}: the ${name} export must be a function (see docs/auth.md).`, 'LOUSHO_AGENT_DIR_INVALID');
    }
    rules[name] = rule as never;
  }
  return { file, auth: auth as AuthFn | readonly AuthFn[], ...rules };
}
