/**
 * Turning SecretRef objects into their values when an agent is built. `{ env }`
 * reads `host.env` first, then the process env (via `globalThis.process?.env`,
 * no `node:*` import, so a Worker build does not break); `{ secret }` asks
 * `host.resolveSecret`. A missing or empty value is LOUSHO_SPEC_SECRET_MISSING
 * naming the spec field — never the secret's value in an error or log line.
 */
import { ConfigurationError } from '../../../execution/errors';
import type { SecretRef } from '../secrets';

/** What resolveSecretRef needs from the host; specToAgent's host (S16) extends it. */
export interface SecretHost {
  /** Value of a named secret from the host's store; undefined when it has none. */
  resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  /** Environment to read `{ env }` refs from. Default: `globalThis.process?.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The process env when there is one (absent in browsers/Workers), else an empty map. */
function processEnv(): Readonly<Record<string, string | undefined>> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

/**
 * The value behind `ref`. `field` (e.g. 'mcpServers.github.env.GITHUB_TOKEN') names it in errors.
 * Missing or empty value → ConfigurationError(code 'LOUSHO_SPEC_SECRET_MISSING', field).
 */
export async function resolveSecretRef(ref: SecretRef, host: SecretHost, field: string): Promise<string> {
  if ('env' in ref) {
    const value = (host.env ?? processEnv())[ref.env];
    if (value === undefined || value === '') {
      throw new ConfigurationError(
        `AgentSpec v2: '${field}' needs the environment variable ${ref.env}, which is not set.`,
        field,
        'LOUSHO_SPEC_SECRET_MISSING'
      );
    }
    return value;
  }
  if (host.resolveSecret === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' needs the secret '${ref.secret}', but this host has no secret store.`,
      field,
      'LOUSHO_SPEC_SECRET_MISSING'
    );
  }
  const value = await host.resolveSecret(ref.secret);
  if (value === undefined || value === '') {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' needs the secret '${ref.secret}', which is not set. Add it in Settings → Secrets.`,
      field,
      'LOUSHO_SPEC_SECRET_MISSING'
    );
  }
  return value;
}

/** A string-or-SecretRef value: strings pass through; refs go through resolveSecretRef. */
export async function resolveStringOrSecret(value: string | SecretRef, host: SecretHost, field: string): Promise<string> {
  if (typeof value === 'string') return value;
  return resolveSecretRef(value, host, field);
}
