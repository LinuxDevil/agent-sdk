/**
 * Reading a spec file and parsing its text as YAML or JSON, shared by v1's
 * `loadSpec` and v2's `loadSpecV2`. Internal: not re-exported from
 * `src/spec/index.ts` (not part of the public API).
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ConfigurationError, ValidationError } from '../execution/errors';

/** Parses raw spec file text as YAML or JSON, chosen by (lowercased) extension. */
export function parseSpecData(raw: string, ext: string, filePath: string): unknown {
  const format = ext === '.yaml' || ext === '.yml' ? 'YAML' : ext === '.json' ? 'JSON' : undefined;
  if (format !== undefined) {
    try {
      return format === 'YAML' ? parseYaml(raw) : JSON.parse(raw);
    } catch (error) {
      throw new ValidationError(
        `loadSpec: '${filePath}' is not valid ${format}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'LOUSHO_SPEC_INVALID'
      );
    }
  }
  throw new ConfigurationError(
    `loadSpec: unsupported extension '${ext}' for '${filePath}'. Use .yaml, .yml or .json`,
    undefined,
    'LOUSHO_SPEC_UNSUPPORTED_FORMAT'
  );
}

/** Reads the spec file; a missing file reports LOUSHO_SPEC_NOT_FOUND rather than a raw ENOENT. */
export function readSpecFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ConfigurationError(`loadSpec: '${filePath}' does not exist.`, undefined, 'LOUSHO_SPEC_NOT_FOUND', { cause: error });
    }
    throw error;
  }
}
