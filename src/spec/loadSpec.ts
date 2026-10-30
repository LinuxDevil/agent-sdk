import * as path from 'node:path';
import { AgentSpec, agentSpecSchema } from './schema';
import { ConfigurationError, ValidationError } from '../execution/errors';
import { closestMatch } from '../utils/closestMatch';
import { issueMessage, issuePath, type SchemaIssue } from '../utils/zodCompat';
import { parseSpecData, readSpecFile } from './specFile';

function formatZodError(filePath: string, error: { issues: readonly SchemaIssue[] }, typos: string[]): string {
  const details = error.issues
    // The schema's messages start with this prefix for other callers; here the line already says it failed validation.
    .map((issue) => `'${issuePath(issue)}': ${issueMessage(issue).replace(/^AgentSpec validation failed: /, '')}`)
    .concat(typos)
    .join('; ');
  return `loadSpec: '${filePath}' failed validation - ${details}`;
}

/** Top-level fields that look like typos of a spec field: "unknown field 'promt' (did you mean 'prompt'?)". */
function unknownFieldTypos(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const known = Object.keys(agentSpecSchema.shape);
  // `createAgent({ model: 'openai/gpt-4o-mini' })` and agent directories take a top-level model; a spec does not.
  const modelHint = 'provider' in data ? [] : [`unknown field 'model' (a spec sets the model under provider: { type: openai, model: gpt-4o-mini })`];
  return Object.keys(data).flatMap((field) => {
    if (field === 'model') return modelHint;
    const suggestion = known.includes(field) ? undefined : closestMatch(field, known);
    return suggestion ? [`unknown field '${field}' (did you mean '${suggestion}'?)`] : [];
  });
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
