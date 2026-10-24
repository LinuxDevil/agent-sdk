/**
 * The Context Hub (spec 0001-prompts-context-hub): namespaced shared memory
 * between agents on one daemon.
 *
 * - `POST /api/v1/hub` publishes `{agent_id, namespace, key, value, scope?,
 *   ttl?}`. `agent_id` is the caller's reporter identity - the threat model
 *   trusts loopback, so it is sent in the body, not derived from auth. One
 *   entry per (namespace, agent_id, key): `entry_id` is their sha256, so
 *   republishing a key updates the row in place (a retried publish is
 *   idempotent). `value` is stored verbatim when a string, else JSON-encoded;
 *   `ttl` is a lifetime in milliseconds.
 * - `GET /api/v1/hub?agent_id&namespace&scope&key&limit` queries. Scope is
 *   enforced HERE, daemon side, against the caller's `agent_id` (required):
 *   `private` returns only the caller's own private entries, `fleet` returns
 *   every agent's fleet entries, and no `scope` returns both - a private
 *   entry of another agent can never be read through this endpoint (the
 *   scope is organizational, not a security boundary, but the filter is not
 *   the client's job). Entries past their `ttl` are filtered at read.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SDKError } from '../../execution/errors';
import { intParam, parseJsonBody, sendJson, type Route } from './index';

export const HUB_SCOPES = ['private', 'fleet'] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

const publishBody = z.object({
  agent_id: z.string().min(1),
  namespace: z.string().min(1).max(200),
  key: z.string().min(1).max(500),
  /** Any JSON value (or a plain string, stored as-is). */
  value: z.unknown(),
  scope: z.enum(HUB_SCOPES).default('private'),
  /** Lifetime in milliseconds; absent means the entry does not expire. */
  ttl: z.number().int().positive().optional(),
});

export interface HubEntryRow {
  entry_id: string;
  namespace: string;
  agent_id: string | null;
  key: string;
  value: string | null;
  scope: string;
  created_at: number;
  ttl: number | null;
  expires_at: number | null;
}

function entryRow(row: Record<string, unknown>): HubEntryRow {
  const createdAt = Number(row.created_at);
  const ttl = row.ttl === null || row.ttl === undefined ? null : Number(row.ttl);
  return {
    entry_id: String(row.entry_id),
    namespace: String(row.namespace),
    agent_id: (row.agent_id as string | null) ?? null,
    key: String(row.key),
    value: (row.value as string | null) ?? null,
    scope: String(row.scope),
    created_at: createdAt,
    ttl,
    expires_at: ttl === null ? null : createdAt + ttl,
  };
}

/** One row per (namespace, agent_id, key): republishing the same key updates value/scope/ttl in place. */
const ENTRY_UPSERT = `
  INSERT INTO hub_entries (entry_id, namespace, agent_id, "key", value, scope, created_at, ttl)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(entry_id) DO UPDATE SET
    value = excluded.value,
    scope = excluded.scope,
    created_at = excluded.created_at,
    ttl = excluded.ttl
`;

export const hubRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/hub',
    handle: async ({ db, res, readBody }) => {
      const parsed = publishBody.safeParse(parseJsonBody(await readBody(1024 * 1024)));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SDKError(
          `Invalid hub publish body: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'bad shape'}.`,
          'LOUSHO_REQUEST_INVALID',
          { appendHelp: false }
        );
      }
      const { agent_id, namespace, key, value, scope, ttl } = parsed.data;
      const stored = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      // JSON-encoded parts so ('a b','c') and ('a','b c') hash differently.
      const entryId = createHash('sha256').update(JSON.stringify([namespace, agent_id, key])).digest('hex');
      const existed = db.prepare('SELECT entry_id FROM hub_entries WHERE entry_id = ?').get(entryId) !== undefined;
      db.prepare(ENTRY_UPSERT).run(entryId, namespace, agent_id, key, stored, scope, Date.now(), ttl ?? null);
      const row = db.prepare('SELECT * FROM hub_entries WHERE entry_id = ?').get(entryId);
      sendJson(res, existed ? 200 : 201, { entry: row ? entryRow(row) : undefined, created: !existed });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/hub',
    handle: ({ db, res, query }) => {
      const agentId = query.get('agent_id');
      if (!agentId) {
        return sendJson(res, 400, { error: `The 'agent_id' query param is required; scope is enforced against the caller's identity.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      const scope = query.get('scope');
      if (scope !== null && scope !== 'private' && scope !== 'fleet') {
        return sendJson(res, 400, { error: `scope must be 'private' or 'fleet', got '${scope}'.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      const params: (string | number)[] = [];
      let where = '(ttl IS NULL OR created_at + ttl > ?)';
      params.push(Date.now());
      if (scope === 'private') {
        where += ` AND scope = 'private' AND agent_id = ?`;
        params.push(agentId);
      } else if (scope === 'fleet') {
        where += ` AND scope = 'fleet'`;
      } else {
        where += ` AND (scope = 'fleet' OR (scope = 'private' AND agent_id = ?))`;
        params.push(agentId);
      }
      const namespace = query.get('namespace');
      if (namespace !== null) {
        where += ' AND namespace = ?';
        params.push(namespace);
      }
      const key = query.get('key');
      if (key !== null) {
        where += ' AND "key" = ?';
        params.push(key);
      }
      const limit = intParam(query, 'limit', 100, { min: 1, max: 1000 });
      const rows = db.prepare(`SELECT * FROM hub_entries WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
      sendJson(res, 200, { entries: rows.map(entryRow) });
    },
  },
];
