import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { AgentSpec, agentSpecSchema } from './schema';

function formatZodError(filePath: string, error: ZodError): string {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `'${field}': ${issue.message}`;
    })
    .join('; ');
  return `loadSpec: '${filePath}' failed validation - ${details}`;
}

/**
 * Loads and validates an agent spec file. Supports both .yaml/.yml (via
 * the `yaml` package) and .json (via JSON.parse), chosen by file
 * extension. Validated against the zod schema in schema.ts; a missing or
 * invalid field throws an Error whose message names the exact field (e.g.
 * "'prompt': Required").
 */
export function loadSpec(filePath: string): AgentSpec {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  let data: unknown;
  if (ext === '.yaml' || ext === '.yml') {
    data = parseYaml(raw);
  } else if (ext === '.json') {
    data = JSON.parse(raw);
  } else {
    throw new Error(
      `loadSpec: unsupported extension '${ext}' for '${filePath}'. Use .yaml, .yml or .json`
    );
  }

  const result = agentSpecSchema.safeParse(data);
  if (!result.success) {
    throw new Error(formatZodError(filePath, result.error));
  }

  return result.data;
}
