/**
 * The agent-side client of the Context Hub (spec 0001-prompts-context-hub):
 * namespaced shared memory between agents on one daemon.
 *
 * `hub()` builds a `{publish, query}` client when `LOUSHO_OBSERVE` names a
 * collector (or an explicit `url` is passed); `undefined` otherwise. Scope
 * enforcement is the daemon's job - the client simply identifies itself with
 * the same `agent_id` the reporter uses (`.lousho/identity/`), so an agent's
 * `private` entries and its traces share one identity.
 *
 * `hubTools()` adapts the client into `hub_publish`/`hub_query` tools an
 * agent can list in `tools` (`tools: [...hubTools()]`); it returns no tools
 * when no hub is configured, matching the spec's "tools when LOUSHO_OBSERVE
 * is set".
 */

import { z } from 'zod';
import { SDKError } from '../execution/errors';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { toolFailure } from '../tools/built-in/toolFailure';
import { resolveIdentity, resolveProject } from './identity';
import { observeUrlFromEnv } from './reporter';

/** The scopes a hub entry can be published under (see {@link HubPublishInput.scope}). */
export const HUB_SCOPES = ['private', 'fleet'] as const;
/** `'private'` is visible only to the publishing agent; `'fleet'` to every agent on the daemon. */
export type HubScope = (typeof HUB_SCOPES)[number];

/** One `hub_entries` row as `GET /api/v1/hub` serves it (`expires_at` is derived: `created_at + ttl`). */
export interface HubEntry {
  /** The row's id, assigned by the daemon. */
  entry_id: string;
  /** The group the entry lives in (e.g. 'facts', 'handoff'). */
  namespace: string;
  /** The publishing agent's id. */
  agent_id: string | null;
  /** The key inside the namespace. */
  key: string;
  /** The stored value (JSON text for non-strings), or `null`. */
  value: string | null;
  /** `'private'` or `'fleet'`. */
  scope: string;
  /** Publish time (epoch ms). */
  created_at: number;
  /** Lifetime in ms, or `null` when the entry does not expire. */
  ttl: number | null;
  /** `created_at + ttl`, or `null` for non-expiring entries. */
  expires_at: number | null;
}

/** Options of {@link hub} and {@link hubTools}. */
export interface HubOptions {
  /** Collector base URL; default `LOUSHO_OBSERVE`'s resolution. */
  url?: string;
  /**
   * The caller's `agent_id` (scope is enforced against it). Default: the
   * reporter identity of `agentName`+project, the same id traces carry.
   */
  agentId?: string;
  /** Registry name the identity is resolved under (default `'agent'`; pass the agent's `name`). */
  agentName?: string;
  /** Project label for identity resolution; default `LOUSHO_OBSERVE_PROJECT` else the cwd's package name. */
  project?: string;
  /** Bearer token for a `--require-token` daemon (`LOUSHO_OBSERVE_TOKEN`). */
  token?: string;
  /** Project dir for `.lousho/identity/`; default `process.cwd()`. */
  cwd?: string;
  /** Request timeout (default 5000ms). */
  timeoutMs?: number;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable env (tests); default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** What {@link Hub.publish} stores. */
export interface HubPublishInput {
  /** The group the entry lives in (e.g. 'facts', 'handoff'). */
  namespace: string;
  /** The key inside the namespace. */
  key: string;
  /** A string is stored as-is; anything else is JSON-encoded. */
  value: unknown;
  /** `'private'` (default) is visible only to this agent; `'fleet'` to every agent on the daemon. */
  scope?: HubScope;
  /** Lifetime in milliseconds. */
  ttl?: number;
}

/** The filters {@link Hub.query} accepts. */
export interface HubQuery {
  /** Only entries in this namespace; all namespaces when omitted. */
  namespace?: string;
  /** `private` = only this agent's own private entries; `fleet` = all fleet entries; absent = both. */
  scope?: HubScope;
  /** Only the entry with this key. */
  key?: string;
  /** At most this many entries (default 100). */
  limit?: number;
}

/** The Context Hub client {@link hub} returns. */
export interface Hub {
  /** The `agent_id` entries are published and scoped under (resolved on first call). */
  readonly agentId: string;
  /** Store a value; resolves with the entry the daemon wrote. */
  publish(input: HubPublishInput): Promise<HubEntry>;
  /** Read entries matching `filter`; by default own private entries plus all fleet entries. */
  query(filter?: HubQuery): Promise<HubEntry[]>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * A Context Hub client, or `undefined` when no daemon is configured (neither
 * `options.url` nor a `LOUSHO_OBSERVE` env). Identity is resolved lazily -
 * building a client must not write `.lousho/identity/` before the hub is used.
 */
export function hub(options: HubOptions = {}): Hub | undefined {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const url = (options.url ?? observeUrlFromEnv(env))?.replace(/\/+$/, '');
  if (url === undefined) return undefined;
  const token = options.token ?? env?.LOUSHO_OBSERVE_TOKEN;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '.');

  let id: string | undefined;
  const agentId = (): string => {
    id ??=
      options.agentId ??
      resolveIdentity({
        name: options.agentName ?? 'agent',
        project: resolveProject(options.project ?? env?.LOUSHO_OBSERVE_PROJECT, cwd),
        cwd,
      }).agentId;
    return id;
  };

  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const res = await fetchFn(`${url}${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => undefined)) as ({ error?: string } & T) | undefined;
    if (!res.ok) {
      throw new SDKError(
        `The observe daemon answered ${res.status} for ${path}: ${body?.error ?? res.statusText}.`,
        'LOUSHO_REMOTE_REQUEST_FAILED',
        { appendHelp: false }
      );
    }
    return body as T;
  };

  return {
    get agentId() {
      return agentId();
    },
    async publish(input) {
      const body = await request<{ entry: HubEntry }>('/api/v1/hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId(), ...input }),
      });
      return body.entry;
    },
    async query(filter = {}) {
      const params = new URLSearchParams({ agent_id: agentId() });
      if (filter.namespace !== undefined) params.set('namespace', filter.namespace);
      if (filter.scope !== undefined) params.set('scope', filter.scope);
      if (filter.key !== undefined) params.set('key', filter.key);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      const body = await request<{ entries: HubEntry[] }>(`/api/v1/hub?${params}`, { method: 'GET' });
      return body.entries;
    },
  };
}

/* ------------------------------------------------------------------ tools */

const publishInput = z.object({
  namespace: z.string().min(1).describe("The group the entry lives in, e.g. 'facts', 'handoff', 'preferences'."),
  key: z.string().min(1).describe('The key inside the namespace.'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .describe('What to store; objects and arrays are JSON-encoded.'),
  scope: z
    .enum(['private', 'fleet'])
    .optional()
    .describe("'private' (default) is visible only to this agent; 'fleet' is visible to every agent on the daemon."),
  ttl: z.number().int().positive().optional().describe('Optional lifetime in milliseconds; the entry expires afterwards.'),
});

const queryInput = z.object({
  namespace: z.string().optional().describe('Only entries in this namespace; all namespaces when omitted.'),
  scope: z
    .enum(['private', 'fleet'])
    .optional()
    .describe("'private' = only this agent's own private entries; 'fleet' = every agent's fleet entries; omitted = both."),
  key: z.string().optional().describe('Only the entry with this key.'),
  limit: z.number().int().positive().max(1000).optional().describe('At most this many entries (default 100).'),
});

/**
 * `hub_publish` + `hub_query` tools over {@link hub}. Returns `[]` when no
 * collector is configured (`LOUSHO_OBSERVE` unset and no `url` option) - the
 * spec gives agents these tools only when the hub exists. A failed call
 * becomes a tool error the model reads (`LOUSHO_TOOL_EXECUTION_FAILED`), it
 * never fails the run.
 */
export function hubTools(options: HubOptions = {}): DefinedTool[] {
  const client = hub(options);
  if (client === undefined) return [];
  return [
    defineTool({
      name: 'hub_publish',
      description:
        "Publish a value to the Context Hub, this machine's shared memory between agents. " +
        "scope 'private' (default) is visible only to you; 'fleet' is visible to every agent on the daemon.",
      input: publishInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      execute: async (args) => {
        try {
          const entry = await client.publish(args);
          return { ok: true, entry };
        } catch (error) {
          throw toolFailure(`hub_publish: ${error instanceof Error ? error.message : String(error)}`, error);
        }
      },
    }),
    defineTool({
      name: 'hub_query',
      description:
        'Read entries from the Context Hub. Filter by namespace, scope and key; ' +
        "'private' returns only your own entries, 'fleet' returns what any agent shared.",
      input: queryInput,
      annotations: { readOnlyHint: true, destructiveHint: false },
      execute: async (args) => {
        try {
          return { entries: await client.query(args) };
        } catch (error) {
          throw toolFailure(`hub_query: ${error instanceof Error ? error.message : String(error)}`, error);
        }
      },
    }),
  ];
}
