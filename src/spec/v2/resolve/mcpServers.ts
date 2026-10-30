/**
 * `spec.mcpServers` with every SecretRef replaced by its value — the
 * v1-shaped `Record<string, McpServerSpec>` that `createAgent({ mcpServers })`
 * takes. Runs over a shallow copy per server: `env`/`headers` values and
 * `oauth.clientSecret` go through resolveStringOrSecret; key order is kept.
 * No `node:*` import (process env comes via {@link SecretHost}).
 */
import type { McpOAuthOptions, McpServerSpec } from '../../schema';
import type { McpServerSpecV2 } from '../mcpServers';
import type { SecretRef } from '../secrets';
import { resolveStringOrSecret, type SecretHost } from './secrets';

type McpOAuthV2 = Omit<McpOAuthOptions, 'clientSecret'> & { clientSecret?: string | SecretRef };

/**
 * `spec.mcpServers` with every SecretRef replaced by its value: what createAgent({ mcpServers }) takes.
 */
export async function resolveMcpServers(
  servers: Readonly<Record<string, McpServerSpecV2>>,
  host: SecretHost
): Promise<Record<string, McpServerSpec>> {
  const resolved: Record<string, McpServerSpec> = {};
  for (const [name, server] of Object.entries(servers)) {
    resolved[name] = await resolveServer(name, server, host);
  }
  return resolved;
}

/** One entry: resolves `env` (stdio) or `headers`/`oauth.clientSecret` (HTTP); every other field is copied as is. */
async function resolveServer(name: string, server: McpServerSpecV2, host: SecretHost): Promise<McpServerSpec> {
  const copy: Record<string, unknown> = { ...server };
  if ('command' in server) {
    const env = await resolveStringMap(server.env, host, `mcpServers.${name}.env`);
    if (env !== undefined) copy['env'] = env;
    return copy as unknown as McpServerSpec;
  }
  const headers = await resolveStringMap(server.headers, host, `mcpServers.${name}.headers`);
  if (headers !== undefined) copy['headers'] = headers;
  const oauth = await resolveOAuth(server.oauth, host, `mcpServers.${name}.oauth`);
  if (oauth !== undefined) copy['oauth'] = oauth;
  return copy as unknown as McpServerSpec;
}

/** A `Record<string, string | SecretRef>` with each value resolved; undefined stays undefined. */
async function resolveStringMap(
  map: Record<string, string | SecretRef> | undefined,
  host: SecretHost,
  field: string
): Promise<Record<string, string> | undefined> {
  if (map === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    resolved[key] = await resolveStringOrSecret(value, host, `${field}.${key}`);
  }
  return resolved;
}

/** `oauth` with `clientSecret` resolved (field `mcpServers.<server>.oauth.clientSecret`); undefined stays undefined. */
async function resolveOAuth(oauth: McpOAuthV2 | undefined, host: SecretHost, field: string): Promise<McpOAuthOptions | undefined> {
  if (oauth === undefined) return undefined;
  const copy: McpOAuthV2 = { ...oauth };
  if (oauth.clientSecret !== undefined) {
    copy.clientSecret = await resolveStringOrSecret(oauth.clientSecret, host, `${field}.clientSecret`);
  }
  return copy as McpOAuthOptions;
}
