/**
 * The prompt registry (spec 0001-prompts-context-hub).
 *
 * - `POST /api/v1/prompts` publishes `{name, text, labels?, variables?}` as a
 *   new version: `version` auto-increments per name and `hash` (sha256 of the
 *   text) dedupes a republish identical to the current latest - same hash,
 *   same labels and variables answers `200` with the existing row instead of
 *   minting a version. A republish of an OLDER text still creates a version
 *   (a rollback is a real event in the history).
 * - `GET /api/v1/prompts` lists one row per name (latest version, version
 *   count, run count) - Studio's registry table.
 * - `GET /api/v1/prompts/:name` is the version history, text included so a
 *   Studio panel (or a diff) can compare versions without N fetches.
 * - `GET /api/v1/prompts/:name/:version` resolves one version - `:version` is
 *   an integer or `latest`. `latest` is resolved DAEMON SIDE on purpose:
 *   every agent that asks in the same moment gets the same row, which is the
 *   whole point of the movable label.
 *
 * Names go in the URL path, so they may not contain `/`, `@` or whitespace -
 * the same constraint `parsePromptRef` applies on the client.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SDKError } from '../../execution/errors';
import type { SqlDatabase } from '../../storage/sqlite/driver';
import { intParam, parseJsonBody, sendJson, type Route } from './index';

/** A prompt name is a URL path segment and the left half of a `name@version` ref. */
const NAME_PATTERN = /^[^\s@/]{1,200}$/;

const publishBody = z.object({
  name: z.string().regex(NAME_PATTERN, 'a name is a non-empty path segment without whitespace or @ (e.g. "mira", "support-v2")'),
  text: z.string().min(1),
  /** Free-form labels (e.g. ["prod"]); stored verbatim as JSON. */
  labels: z.array(z.string()).or(z.record(z.string(), z.string())).optional(),
  /** Variable names the text interpolates (templating is a later spec; stored verbatim). */
  variables: z.array(z.string()).optional(),
});

export interface PromptRow {
  prompt_id: string;
  name: string;
  version: number;
  labels: unknown;
  variables: unknown;
  hash: string | null;
  text: string | null;
  created_at: number;
}

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

function promptRow(row: Record<string, unknown>): PromptRow {
  return {
    prompt_id: String(row.prompt_id),
    name: String(row.name),
    version: Number(row.version),
    labels: parseJson(row.labels),
    variables: parseJson(row.variables),
    hash: (row.hash as string | null) ?? null,
    text: (row.text as string | null) ?? null,
    created_at: Number(row.created_at),
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** `prompt_id` is deterministic (`sha256(name@version)`): a retried publish of the same version upserts, never duplicates. */
const PROMPT_UPSERT = `
  INSERT INTO prompts (prompt_id, name, version, labels, text, variables, hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(prompt_id) DO UPDATE SET
    labels = excluded.labels,
    text = excluded.text,
    variables = excluded.variables,
    hash = excluded.hash
`;

function latestRow(db: SqlDatabase, name: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM prompts WHERE name = ? ORDER BY version DESC LIMIT 1').get(name);
}

/** Identical republish = same text hash AND same labels/variables JSON as the latest version. */
function isIdenticalTo(latest: Record<string, unknown>, hash: string, labels: string | null, variables: string | null): boolean {
  return latest.hash === hash && (latest.labels ?? null) === labels && (latest.variables ?? null) === variables;
}

export const promptsRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/prompts',
    handle: async ({ db, res, readBody }) => {
      const parsed = publishBody.safeParse(parseJsonBody(await readBody(1024 * 1024)));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SDKError(
          `Invalid prompt publish body: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'bad shape'}.`,
          'LOUSHO_REQUEST_INVALID',
          { appendHelp: false }
        );
      }
      const { name, text, labels, variables } = parsed.data;
      const hash = sha256(text);
      const labelsJson = labels === undefined ? null : JSON.stringify(labels);
      const variablesJson = variables === undefined ? null : JSON.stringify(variables);
      const latest = latestRow(db, name);
      if (latest && isIdenticalTo(latest, hash, labelsJson, variablesJson)) {
        return sendJson(res, 200, { prompt: promptRow(latest), created: false });
      }
      const version = latest === undefined ? 1 : Number(latest.version) + 1;
      const promptId = sha256(`${name}@${version}`);
      db.prepare(PROMPT_UPSERT).run(promptId, name, version, labelsJson, text, variablesJson, hash, Date.now());
      const row = db.prepare('SELECT * FROM prompts WHERE prompt_id = ?').get(promptId);
      sendJson(res, 201, {
        prompt: row
          ? promptRow(row)
          : { prompt_id: promptId, name, version, labels: labels ?? null, variables: variables ?? null, hash, text, created_at: Date.now() },
        created: true,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/prompts',
    handle: ({ db, res, query }) => {
      const limit = intParam(query, 'limit', 200, { min: 1, max: 1000 });
      const name = query.get('name');
      const rows = db
        .prepare(
          `SELECT p.*,
             (SELECT COUNT(*) FROM prompts v WHERE v.name = p.name) AS versions,
             (SELECT COUNT(*) FROM prompt_uses u JOIN prompts q ON q.prompt_id = u.prompt_id WHERE q.name = p.name) AS uses
           FROM prompts p
           WHERE p.version = (SELECT MAX(version) FROM prompts m WHERE m.name = p.name)
             AND (? IS NULL OR p.name = ?)
           ORDER BY p.name LIMIT ?`
        )
        .all(name, name, limit);
      sendJson(res, 200, {
        prompts: rows.map((row) => ({ ...promptRow(row), versions: Number(row.versions), uses: Number(row.uses) })),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/prompts/:name',
    handle: ({ db, res, params }) => {
      const rows = db
        .prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM prompt_uses u WHERE u.prompt_id = p.prompt_id) AS uses
           FROM prompts p WHERE p.name = ? ORDER BY p.version DESC`
        )
        .all(params.name);
      if (rows.length === 0) {
        return sendJson(res, 404, { error: `No prompt '${params.name}'.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      sendJson(res, 200, { name: params.name, versions: rows.map((row) => ({ ...promptRow(row), uses: Number(row.uses) })) });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/prompts/:name/:version',
    handle: ({ db, res, params }) => {
      if (params.version !== 'latest' && !/^\d+$/.test(params.version)) {
        return sendJson(res, 400, { error: `Version '${params.version}' is not an integer or 'latest'.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      const row =
        params.version === 'latest'
          ? latestRow(db, params.name)
          : db.prepare('SELECT * FROM prompts WHERE name = ? AND version = ?').get(params.name, Number(params.version));
      if (row === undefined) {
        return sendJson(res, 404, { error: `No prompt '${params.name}@${params.version}'.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      sendJson(res, 200, { prompt: promptRow(row) });
    },
  },
];
