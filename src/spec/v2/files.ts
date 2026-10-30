/**
 * Node-side helpers for AgentSpec v2 file references (`instructions.file`,
 * tool and hook files): resolve them against the spec's base directory
 * without letting them escape it. The only `src/spec/v2` file that may
 * import `node:*` - the schema files stay browser-safe and never import
 * this one.
 */
import * as path from 'node:path';
import { ConfigurationError } from '../../execution/errors';
import { isSafeRelativePath } from './common';

/** Absolute path of a spec file reference (`instructions.file`, tool/hook files...). Throws LOUSHO_SPEC_INVALID when `rel` escapes `baseDir`. */
export function specFilePath(baseDir: string, field: string, rel: string): string {
  if (!isSafeRelativePath(rel)) {
    throw new ConfigurationError(`AgentSpec v2: '${field}' must be a relative path inside ${baseDir}, got '${rel}'.`, field, 'LOUSHO_SPEC_INVALID');
  }
  const resolved = path.resolve(baseDir, rel);
  // Defence in depth: isSafeRelativePath already keeps `rel` inside, but check the join too.
  if (path.relative(baseDir, resolved).startsWith('..')) {
    throw new ConfigurationError(`AgentSpec v2: '${field}' must be a relative path inside ${baseDir}, got '${rel}'.`, field, 'LOUSHO_SPEC_INVALID');
  }
  return resolved;
}
