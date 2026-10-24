/**
 * The prompt registry (spec 0001-prompts-context-hub).
 *
 * - `POST /api/v1/prompts` publishes `{name, text, labels?, variables?}` as a
 *   new version: `version` auto-increments per name and `hash` (sha256 of the
 *   text) dedupes a push unchanged from the current latest - same hash and
 *   variables answers `200 {unchanged: true, version: <latest>}` instead of
 *   minting a version. A republish of an OLDER text still creates a version
 *   (a rollback is a real event in the history). Array `labels` are moved
 *   onto the resulting version (the new one, or the latest when unchanged).
 * - `GET /api/v1/prompts` lists one row per name (latest version, version
 *   count, run count) - Studio's registry table.
 * - `GET /api/v1/prompts/:name` is the version history, text included so a
 *   Studio panel (or a diff) can compare versions without N fetches.
 * - `GET /api/v1/prompts/:name/:ref` resolves one version - `:ref` is an
 *   integer, `latest`, or a label. `latest` and labels are resolved DAEMON
 *   SIDE on purpose: every agent that asks in the same moment gets the same
 *   row, which is the whole point of a movable label.
 * - `PUT /api/v1/prompts/:name/labels/:label` `{version}` moves a label. The
 *   `prompt_labels` primary key keeps a label on exactly one version; every
 *   served row's `labels` is the sorted list of labels pointing at it.
 *
 * Names go in the URL path, so they may not contain `/`, `@` or whitespace -
 * the same constraint `parsePromptRef` applies on the client.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import type { SqlDatabase } from '../../storage/sqlite/driver';
import { badRequest, intParam, requireJsonBody, sendJson, type Route } from './httpKit';

/** A prompt name is a URL path segment and the left half of a `name@ref` ref. */
const NAME_PATTERN = /^[^\s@/]{1,200}$/;

/** An integer version ref (`latest` is the other non-label ref). */
const VERSION_PATTERN = /^\d+$/;

/** A label is a name that is not itself a ref (`latest`, or all digits = a version). */
const isLabel = (value: string): boolean => NAME_PATTERN.test(value) && value !== 'latest' && !VERSION_PATTERN.test(value);

const LABEL_RULE = "a label is a path segment without whitespace, @ or /, and not 'latest' or all digits (those are refs)";

const publishBody = z.object({
  name: z.string().regex(NAME_PATTERN, 'a name is a non-empty path segment without whitespace or @ (e.g. "mira", "support-v2")'),
  text: z.string().min(1),
  /** Labels to point at the published version (e.g. ["prod"]); a record form is stored verbatim in the legacy column only. */
  labels: z.array(z.string().refine(isLabel, LABEL_RULE)).or(z.record(z.string(), z.string())).optional(),
  /** Variable names the text interpolates (templating is a later spec; stored verbatim). */
  variables: z.array(z.string()).optional(),
});

const labelBody = z.object({ version: z.number().int().positive() });

interface PromptRow {
  prompt_id: string;
  name: string;
  version: number;
  labels: string[];
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

/** Every prompt SELECT reads `p.*` plus the labels pointing at the row (a JSON array, sorted). */
const PROMPT_COLUMNS = `p.*,
  (SELECT json_group_array(label) FROM (SELECT l.label FROM prompt_labels l WHERE l.name = p.name AND l.version = p.version ORDER BY l.label)) AS current_labels`;

/** A served row: `labels` is the current label set (the legacy `prompts.labels` column stays out of the response). */
function promptRow(row: Record<string, unknown>): PromptRow {
  const labels = parseJson(row.current_labels);
  return {
    prompt_id: String(row.prompt_id),
    name: String(row.name),
    version: Number(row.version),
    labels: Array.isArray(labels) ? labels.map(String) : [],
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

/** One statement moves a label: the (name, label) primary key keeps it on a single version. */
const LABEL_UPSERT = `
  INSERT INTO prompt_labels (name, label, version, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(name, label) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
`;

function latestRow(db: SqlDatabase, name: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompts p WHERE p.name = ? ORDER BY p.version DESC LIMIT 1`).get(name);
}

function versionRow(db: SqlDatabase, name: string, version: number): Record<string, unknown> | undefined {
  return db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompts p WHERE p.name = ? AND p.version = ?`).get(name, version);
}

/** The row `ref` names: `latest`, an integer version, or a label (`undefined` when nothing matches). */
function rowForRef(db: SqlDatabase, name: string, ref: string): Record<string, unknown> | undefined {
  if (ref === 'latest') return latestRow(db, name);
  if (VERSION_PATTERN.test(ref)) return versionRow(db, name, Number(ref));
  return db
    .prepare(
      `SELECT ${PROMPT_COLUMNS} FROM prompt_labels pl JOIN prompts p ON p.name = pl.name AND p.version = pl.version
       WHERE pl.name = ? AND pl.label = ?`
    )
    .get(name, ref);
}

/** Point each label at `name@version`, moving it off whichever version held it. */
function assignLabels(db: SqlDatabase, name: string, version: number, labels: readonly string[]): void {
  const upsert = db.prepare(LABEL_UPSERT);
  const now = Date.now();
  for (const label of labels) upsert.run(name, label, version, now);
}

/** Unchanged = same text hash AND same variables JSON as the latest version (labels move; they never mint a version). */
function isUnchanged(latest: Record<string, unknown>, hash: string, variables: string | null): boolean {
  return latest.hash === hash && (latest.variables ?? null) === variables;
}

function notFound(res: ServerResponse, what: string): void {
  sendJson(res, 404, { error: `No prompt '${what}'.`, code: 'LOUSHO_REQUEST_INVALID' });
}

export const promptsRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/prompts',
    handle: async ({ db, res, readBody }) => {
      const { name, text, labels, variables } = requireJsonBody(
        publishBody,
        await readBody(1024 * 1024),
        'prompt publish'
      );
      const hash = sha256(text);
      const labelList = Array.isArray(labels) ? labels : [];
      const variablesJson = variables === undefined ? null : JSON.stringify(variables);
      const latest = latestRow(db, name);
      if (latest && isUnchanged(latest, hash, variablesJson)) {
        const version = Number(latest.version);
        assignLabels(db, name, version, labelList);
        const row = labelList.length > 0 ? (versionRow(db, name, version) ?? latest) : latest;
        return sendJson(res, 200, { prompt: promptRow(row), created: false, version, unchanged: true });
      }
      const version = latest === undefined ? 1 : Number(latest.version) + 1;
      const promptId = sha256(`${name}@${version}`);
      const labelsJson = labels === undefined ? null : JSON.stringify(labels);
      db.prepare(PROMPT_UPSERT).run(promptId, name, version, labelsJson, text, variablesJson, hash, Date.now());
      assignLabels(db, name, version, labelList);
      const row = versionRow(db, name, version);
      sendJson(res, 201, {
        prompt: row
          ? promptRow(row)
          : { prompt_id: promptId, name, version, labels: [...labelList].sort(), variables: variables ?? null, hash, text, created_at: Date.now() },
        created: true,
        version,
        unchanged: false,
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
          `SELECT ${PROMPT_COLUMNS},
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
          `SELECT ${PROMPT_COLUMNS}, (SELECT COUNT(*) FROM prompt_uses u WHERE u.prompt_id = p.prompt_id) AS uses
           FROM prompts p WHERE p.name = ? ORDER BY p.version DESC`
        )
        .all(params.name);
      if (rows.length === 0) return notFound(res, params.name);
      sendJson(res, 200, { name: params.name, versions: rows.map((row) => ({ ...promptRow(row), uses: Number(row.uses) })) });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/prompts/:name/:ref',
    handle: ({ db, res, params }) => {
      const { name, ref } = params;
      if (ref !== 'latest' && !VERSION_PATTERN.test(ref) && !isLabel(ref)) {
        return badRequest(res, `'${ref}' is not a version (an integer or 'latest') or a label: ${LABEL_RULE}.`);
      }
      const row = rowForRef(db, name, ref);
      if (row === undefined) return notFound(res, `${name}@${ref}`);
      sendJson(res, 200, { prompt: promptRow(row) });
    },
  },
  {
    method: 'PUT',
    path: '/api/v1/prompts/:name/labels/:label',
    handle: async ({ db, res, params, readBody }) => {
      const { name, label } = params;
      if (!isLabel(label)) return badRequest(res, `'${label}' is not a valid label: ${LABEL_RULE}.`);
      const { version } = requireJsonBody(labelBody, await readBody(64 * 1024), 'prompt label');
      if (versionRow(db, name, version) === undefined) return notFound(res, `${name}@${version}`);
      const previous = db.prepare('SELECT version FROM prompt_labels WHERE name = ? AND label = ?').get(name, label);
      db.prepare(LABEL_UPSERT).run(name, label, version, Date.now());
      sendJson(res, 200, { name, label, version, previous_version: previous === undefined ? null : Number(previous.version) });
    },
  },
];
