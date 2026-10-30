/**
 * Secret references for AgentSpec v2: a spec names a secret instead of
 * embedding the value — `{ env: 'GITHUB_TOKEN' }` reads the environment, and
 * `{ secret: 'github-token' }` asks the host's secret store (Studio: Settings
 * → Secrets). Specs are files in git and are exported, so they only ever hold
 * refs; the `resolve*` helpers (src/spec/v2/resolve/) turn them into values.
 * Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { anyError } from '../../utils/zodCompat';
import { forwardIssues } from './common';

/** A reference to a secret: an environment variable, or a name in the host's secret store (Studio: Settings → Secrets). */
export type SecretRef = { env: string } | { secret: string };

/** What an `{ env }` name must look like: a shell-style variable name. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S05 integration credentials, S22 channel secrets)
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a `{ secret }` name must look like: 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S05 integration credentials, S22 channel secrets)
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const envRefSchema = z
  .object({ env: z.string().regex(ENV_NAME_PATTERN, 'must be an environment variable name such as GITHUB_TOKEN') })
  .strict();

const namedSecretRefSchema = z
  .object({
    secret: z.string().regex(SECRET_NAME_PATTERN, 'must be a secret name: 1-64 letters, digits, dots, dashes or underscores'),
  })
  .strict();

/** A `{ env: 'NAME' }` or `{ secret: 'name' }` ref — exactly one of the two keys, nothing else. */
export const secretRefSchema = z.union(
  [envRefSchema, namedSecretRefSchema],
  anyError("must be { env: 'NAME' } or { secret: 'name' }")
);

/** A literal string or a SecretRef (fields that may hold either, e.g. integration credentials, MCP env). */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S05 integration credentials)
export const stringOrSecretSchema = z.union(
  [z.string(), secretRefSchema],
  anyError("must be a string, { env: 'NAME' } or { secret: 'name' }")
);

/** Whether `value` is a SecretRef (shape only: one key — `env` or `secret` — with a string value). */
export function isSecretRef(value: unknown): value is SecretRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0];
  return (key === 'env' || key === 'secret') && typeof (value as Record<string, unknown>)[key] === 'string';
}

/**
 * Adds issues for a SecretRef-shaped `value` at `path`, validating against the
 * branch its single key selects ({env} → the env shape, else {secret}). That
 * keeps the issue's path pointing at the offending key (`env.GITHUB_TOKEN.env`)
 * instead of the union's generic failure.
 */
export function addSecretRefIssues(value: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
  const schema = value !== null && typeof value === 'object' && 'env' in value ? envRefSchema : namedSecretRefSchema;
  forwardIssues(schema.safeParse(value), ctx, path);
}
