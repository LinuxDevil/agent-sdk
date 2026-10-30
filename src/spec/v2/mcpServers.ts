/**
 * The `mcpServers` section of AgentSpec v2: a record of server name to the
 * v1 entry shape (stdio `command` or HTTP `url`), with SecretRef allowed where
 * secrets go — `env`, `headers` and `oauth.clientSecret`. The legacy v1 list
 * form `[{ name, ... }]` is not accepted here; `upgradeSpec` (S02) hands v2 the
 * record v1's parser produces. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import type { McpHttpServerSpec, McpOAuthOptions, McpStdioServerSpec } from '../schema';
import { mcpServerSpecSchema } from '../schema';
import { forwardIssues } from './common';
import { addSecretRefIssues, isSecretRef, type SecretRef } from './secrets';

/** MCP server names become the `<server>__<tool>` prefix, so they follow the tool-name alphabet. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S03 secret refs, Studio name validation)
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** An MCP server entry as a v2 spec writes it: v1's McpServerSpec, with SecretRef allowed where secrets go. */
export type McpServerSpecV2 =
  | (Omit<McpStdioServerSpec, 'env'> & { env?: Record<string, string | SecretRef> })
  | (Omit<McpHttpServerSpec, 'headers' | 'oauth'> & {
      headers?: Record<string, string | SecretRef>;
      oauth?: Omit<McpOAuthOptions, 'clientSecret'> & { clientSecret?: string | SecretRef };
    });

/**
 * A copy of `map` with every SecretRef-shaped value swapped for the string
 * 'secret-ref' (issues added at [...field, key] when the shape is bad), so v1's
 * string-map check never sees the ref object. Values that are neither strings
 * nor SecretRefs stay as they are — v1 reports them at the value's path — and
 * the map gets v1's own "'<field>' must be a map of string to string" issue,
 * the message v1 itself gives a non-object map.
 */
function refPlaceholders(map: unknown, ctx: z.RefinementCtx, field: string): Record<string, unknown> | undefined {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return undefined;
  let changed = false;
  let badValue = false;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (isSecretRef(value)) {
      addSecretRefIssues(value, ctx, [field, key]);
      copy[key] = 'secret-ref';
      changed = true;
    } else {
      if (typeof value !== 'string') badValue = true;
      copy[key] = value;
    }
  }
  if (badValue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${field}' must be a map of string to string`, path: [field] });
  }
  return changed ? copy : undefined;
}

/** `oauth` of `entry` with a SecretRef `clientSecret` swapped for 'secret-ref'; undefined when nothing changed. */
function oauthPlaceholder(oauth: unknown, ctx: z.RefinementCtx): Record<string, unknown> | undefined {
  if (oauth === null || typeof oauth !== 'object' || Array.isArray(oauth)) return undefined;
  const clientSecret = (oauth as Record<string, unknown>)['clientSecret'];
  if (!isSecretRef(clientSecret)) return undefined;
  addSecretRefIssues(clientSecret, ctx, ['oauth', 'clientSecret']);
  return { ...(oauth as Record<string, unknown>), clientSecret: 'secret-ref' };
}

/**
 * A copy of `entry` where SecretRef values under `env`, `headers` and
 * `oauth.clientSecret` are replaced by the placeholder string 'secret-ref'
 * before v1's schema sees them (and validated, issues on the original paths).
 * The parsed spec keeps the refs — only the value handed to v1 is substituted.
 */
function withRefPlaceholders(entry: unknown, ctx: z.RefinementCtx): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const e = entry as Record<string, unknown>;
  const env = refPlaceholders(e['env'], ctx, 'env');
  const headers = refPlaceholders(e['headers'], ctx, 'headers');
  const oauth = oauthPlaceholder(e['oauth'], ctx);
  if (env === undefined && headers === undefined && oauth === undefined) return entry;
  const copy: Record<string, unknown> = { ...e };
  if (env !== undefined) copy['env'] = env;
  if (headers !== undefined) copy['headers'] = headers;
  if (oauth !== undefined) copy['oauth'] = oauth;
  return copy;
}

/**
 * One entry: secret refs are swapped for placeholder strings and validated
 * first ({@link withRefPlaceholders}), then v1's mcpServerSpecSchema runs on
 * the copy — issues re-pathed under the entry and stripped of v1's
 * "AgentSpec validation failed: " prefix by {@link forwardIssues}. The raw
 * value is kept (no v1 transform output), so the parsed spec keeps the refs.
 */
const mcpServerEntrySchema = z.any().superRefine((value, ctx) => {
  forwardIssues(mcpServerSpecSchema.safeParse(withRefPlaceholders(value, ctx)), ctx);
});

/**
 * `AgentSpecV2.mcpServers`: a map of server name to server config (record form
 * only). Names are checked in a superRefine rather than a record key schema so
 * both zod majors report the same issue (zod 4 wraps key failures in a generic
 * "Invalid key in record").
 */
export const mcpServersSchema = z
  .record(z.string(), mcpServerEntrySchema)
  .superRefine((servers, ctx) => {
    for (const name of Object.keys(servers)) {
      if (!MCP_SERVER_NAME.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'server names must be 1-64 letters, digits, dashes or underscores',
          path: [name],
        });
      }
    }
  });
