import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { AgentSpec, agentSpecSchema } from './schema';
import { ConfigurationError, ValidationError } from '../execution/errors';
import { closestMatch } from '../utils/closestMatch';

function formatZodError(filePath: string, error: ZodError, typos: string[]): string {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `'${field}': ${issue.message}`;
    })
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
    'LOUSHY_SPEC_UNSUPPORTED_FORMAT'
  );
}

/**
 * Loads and validates an agent spec file. Supports both .yaml/.yml (via
 * the `yaml` package) and .json (via JSON.parse), chosen by file
 * extension. Validated against the zod schema in schema.ts; a missing or
 * invalid field throws a `ValidationError` (`code: 'LOUSHY_SPEC_INVALID'`)
 * whose message names the exact field (e.g. "'prompt': Required"); a
 * top-level field that looks like a typo of a spec field (`promt`) throws
 * `LOUSHY_SPEC_UNKNOWN_FIELD` with a "did you mean" suggestion. Other
 * unknown fields are ignored.
 */
export function loadSpec(filePath: string): AgentSpec {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  const data = parseSpecData(raw, ext, filePath);

  const typos = unknownFieldTypos(data);
  const result = agentSpecSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(formatZodError(filePath, result.error, typos), undefined, 'LOUSHY_SPEC_INVALID');
  }
  if (typos.length > 0) {
    throw new ConfigurationError(`loadSpec: '${filePath}': ${typos.join('; ')}`, undefined, 'LOUSHY_SPEC_UNKNOWN_FIELD');
  }

  return result.data;
}
