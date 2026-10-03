import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentSpec, agentSpecSchema } from './schema';
import { ConfigurationError, ValidationError } from '../execution/errors';
import { closestMatch } from '../utils/closestMatch';
import { issueMessage, issuePath, type SchemaIssue } from '../utils/zodCompat';

function formatZodError(filePath: string, error: { issues: readonly SchemaIssue[] }, typos: string[]): string {
  const details = error.issues
    .map((issue) => `'${issuePath(issue)}': ${issueMessage(issue)}`)
    .concat(typos)
    .join('; ');
  return `loadSpec: '${filePath}' failed validation - ${details}`;
}

/** Top-level fields that look like typos of a spec field: "unknown field 'promt' (did you mean 'prompt'?)". */
function unknownFieldTypos(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const known = Object.keys(agentSpecSchema.shape);
  return Object.keys(data).flatMap((field) => {
    const suggestion = known.includes(field) ? undefined : closestMatch(field, known);
    return suggestion ? [`unknown field '${field}' (did you mean '${suggestion}'?)`] : [];
  });
}

/** Parses raw spec file text as YAML or JSON, chosen by (lowercased) extension. */
function parseSpecData(raw: string, ext: string, filePath: string): unknown {
  if (ext === '.yaml' || ext === '.yml') return parseYaml(raw);
  if (ext === '.json') return JSON.parse(raw);
  throw new ConfigurationError(
    `loadSpec: unsupported extension '${ext}' for '${filePath}'. Use .yaml, .yml or .json`,
    undefined,
    'LOUSHO_SPEC_UNSUPPORTED_FORMAT'
  );
}

/** Reads the spec file; a missing file reports LOUSHO_SPEC_NOT_FOUND rather than a raw ENOENT. */
function readSpecFile(filePath: string): string {
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

/**
 * Loads and validates an agent spec file. Supports both .yaml/.yml (via
 * the `yaml` package) and .json (via JSON.parse), chosen by file
 * extension. A path that does not exist throws `LOUSHO_SPEC_NOT_FOUND`
 * (not a raw ENOENT). Validated against the zod schema in schema.ts; a
 * missing or invalid field throws a `ValidationError`
 * (`code: 'LOUSHO_SPEC_INVALID'`)
 * whose message names the exact field (e.g. "'prompt': Required"); a
 * top-level field that looks like a typo of a spec field (`promt`) throws
 * `LOUSHO_SPEC_UNKNOWN_FIELD` with a "did you mean" suggestion. Other
 * unknown fields are ignored.
 */
export function loadSpec(filePath: string): AgentSpec {
  const raw = readSpecFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const data = parseSpecData(raw, ext, filePath);

  const typos = unknownFieldTypos(data);
  const result = agentSpecSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(formatZodError(filePath, result.error, typos), undefined, 'LOUSHO_SPEC_INVALID');
  }
  if (typos.length > 0) {
    throw new ConfigurationError(`loadSpec: '${filePath}': ${typos.join('; ')}`, undefined, 'LOUSHO_SPEC_UNKNOWN_FIELD');
  }

  return result.data;
}
