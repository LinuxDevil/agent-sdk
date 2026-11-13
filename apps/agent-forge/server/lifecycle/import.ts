/**
 * Agent import (L08a) - `POST /agents/import/preview` and
 * `POST /agents/import`: the other half of L07's export.
 *
 * `parseImportText` accepts pasted YAML, a JSON spec or an
 * `lousho.agent-bundle` (up to 1 MB), upgrades v1 specs to v2 and
 * validates against `agentSpecV2Schema`. `previewImport` answers what the
 * import sheet shows before committing - the id each mode would write,
 * the name clash, readiness rows, bundle prompts and warnings.
 * `runImport` writes the agent under `withAgentLock(resolvedId)` in one
 * of three modes (`new`/`copy` start disabled with a `create` version;
 * `replace` keeps the target's enable/publish state and captures an
 * `update` version the store skips when nothing changed), then
 * best-effort registers the bundle's prompts with the observe daemon -
 * failures are ignored, the import still succeeds.
 *
 * Per-workspace stores come from `workspaceOf(req)` (the workspace seam);
 * `ImportDeps` carries only Studio-global services (the secrets store the
 * readiness rows read, an optional fetch override for tests).
 */
import type { Express, Request, Response } from 'express';
import { parse as parseYaml } from 'yaml';
import { agentSpecV2Schema, upgradeSpec, type AgentSpecV2 } from '@linuxdevil/lousho';
import { isValidAgentId } from '../../shared/agentId';
import { LabelError, normalizeLabels } from '../../shared/labels';
import type { AgentBundle, AgentMeta, AgentRecord, ImportMode, ImportPreview, ImportRequest } from '../../shared/wireTypes';
import { computeRequirements, requirementDeps } from '../author/requirements';
import { readAgentRecord } from '../agentRecord';
import { asyncRoute, sendError } from '../http/routeUtils';
import { daemonHeaders, observeTarget } from '../observeProxy';
import type { SecretsStore } from '../secretsStore';
import { defaultMeta, flattenSpecIssues } from '../storage/agentRepo';
import { ChainInvalidError } from '../triggers/chainTriggers';
import { agentIdTaken } from '../storage/agentIds';
import { withAgentLock } from '../storage/atomic';
import type { WorkspaceContext } from '../workspace/context';
import { workspaceOf } from '../workspace/middleware';
import { resolveFreshId, resolveNextCopyId, slugifyAgentId } from './agentIds';

/** The pasted text cap - `express.json`'s 2 MB body limit stays the outer bound. */
const MAX_IMPORT_BYTES = 1024 * 1024;

/** The daemon call deadline for prompt registration (same as the export's). */
const DAEMON_TIMEOUT_MS = 8000;

/**
 * A refused import: `status`/`code` map straight onto the error response
 * (`{ error, code, details? }`); `details` carries the schema issue list
 * on `LOUSHO_IMPORT_INVALID`.
 */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Studio-global services the import routes need (per-workspace stores come from `workspaceOf(req)`). */
export interface ImportDeps {
  /** The app's one SecretsStore - `computeRequirements` reads stored keys and named secrets through it. */
  secrets: SecretsStore;
  /** Daemon `fetch` override for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bundle's prompts, keeping only well-formed `{ name, version, content }` entries. */
function bundlePrompts(raw: unknown): AgentBundle['prompts'] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is AgentBundle['prompts'][number] =>
      isObject(entry) && typeof entry.name === 'string' && typeof entry.version === 'number' && typeof entry.content === 'string'
  );
}

/** A parsed import: the upgraded v2 spec plus where its labels/prompts came from. */
export interface ParsedImport {
  format: ImportPreview['format'];
  spec: AgentSpecV2;
  labels: string[];
  prompts: AgentBundle['prompts'];
  warnings: string[];
}

/**
 * Parses pasted import text into an upgraded, schema-valid spec v2.
 * YAML when the text does not start with `{`, JSON otherwise; a JSON
 * object with `kind: 'lousho.agent-bundle'` contributes its labels
 * (through L13's `normalizeLabels` - a `LabelError` becomes
 * `LOUSHO_IMPORT_INVALID`) and prompts. Every failure is an
 * {@link ImportError} with the route's status/code.
 */
/** `JSON.parse` mapped onto `LOUSHO_IMPORT_INVALID`. */
function parseJsonDoc(trimmed: string): unknown {
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new ImportError(`Not valid JSON: ${(error as Error).message}`, 400, 'LOUSHO_IMPORT_INVALID');
  }
}

/** `yaml`'s parse mapped onto `LOUSHO_IMPORT_INVALID`. */
function parseYamlDoc(trimmed: string): unknown {
  try {
    return parseYaml(trimmed);
  } catch (error) {
    throw new ImportError(`Not valid YAML: ${(error as Error).message}`, 400, 'LOUSHO_IMPORT_INVALID');
  }
}

/** A bundle document's spec/labels/prompts; a newer `version` is refused outright. */
function bundleParts(doc: Record<string, unknown>): { rawSpec: unknown; labels: string[]; prompts: AgentBundle['prompts'] } {
  if (doc.version !== 1) {
    throw new ImportError(`This bundle was made by a newer Studio (version ${String(doc.version)}).`, 400, 'LOUSHO_IMPORT_BUNDLE_VERSION');
  }
  let labels: string[];
  try {
    labels = normalizeLabels(doc.labels);
  } catch (error) {
    if (error instanceof LabelError) throw new ImportError(error.message, 400, 'LOUSHO_IMPORT_INVALID');
    throw error;
  }
  return { rawSpec: doc.spec, labels, prompts: bundlePrompts(doc.prompts) };
}

/** Splits the trimmed text into format + raw document: JSON spec, bundle, or YAML. */
function splitDocument(trimmed: string): { format: ParsedImport['format']; rawSpec: unknown; labels: string[]; prompts: AgentBundle['prompts'] } {
  if (!trimmed.startsWith('{')) {
    return { format: 'yaml', rawSpec: parseYamlDoc(trimmed), labels: [], prompts: [] };
  }
  const doc = parseJsonDoc(trimmed);
  if (!isObject(doc) || doc.kind !== 'lousho.agent-bundle') {
    return { format: 'json', rawSpec: doc, labels: [], prompts: [] };
  }
  return { format: 'bundle', ...bundleParts(doc) };
}

/** `upgradeSpec` + `agentSpecV2Schema` validation; the first issue's `path: message` is the error. */
function upgradeAndValidate(rawSpec: unknown): AgentSpecV2 {
  let upgraded: unknown;
  try {
    upgraded = upgradeSpec(rawSpec);
  } catch (error) {
    throw new ImportError(`Not a valid spec: ${(error as Error).message}`, 400, 'LOUSHO_IMPORT_INVALID');
  }
  const result = agentSpecV2Schema.safeParse(upgraded);
  if (!result.success) {
    const issues = flattenSpecIssues(result.error.issues);
    const first = issues[0];
    throw new ImportError(`${first.path}: ${first.message}`, 400, 'LOUSHO_IMPORT_INVALID', { issues });
  }
  return result.data;
}

export function parseImportText(text: string): ParsedImport {
  const trimmed = text.trim();
  if (trimmed === '') throw new ImportError('Paste a spec or a bundle first.', 400, 'LOUSHO_IMPORT_EMPTY');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_IMPORT_BYTES) {
    throw new ImportError('That import is over 1 MB.', 400, 'LOUSHO_IMPORT_TOO_LARGE');
  }

  const { format, rawSpec, labels, prompts } = splitDocument(trimmed);
  const hadV2 = isObject(rawSpec) && rawSpec.version === 2;
  const spec = upgradeAndValidate(rawSpec);
  const warnings: string[] = hadV2 ? [] : ['Upgraded from spec v1.'];
  return { format, spec, labels, prompts, warnings };
}

/** The `exists` predicate the id resolvers share: spec file or leftover sidecar dir. */
function idTaken(ws: WorkspaceContext, id: string): boolean {
  return agentIdTaken(ws.repo, id);
}

/**
 * The id `req.mode` would write, or the {@link ImportError} that refuses
 * it: `replace` needs a valid, existing `targetId`; `copy` derives its
 * base from `targetId` (validated - it lands in an id, never a path
 * unvalidated) or the suggested id.
 */
async function resolveImportId(req: ImportRequest, ws: WorkspaceContext, suggestedId: string): Promise<string> {
  if (req.mode === 'replace') {
    if (req.targetId === undefined) throw new ImportError('Pick the agent to replace.', 400, 'LOUSHO_IMPORT_TARGET_REQUIRED');
    if (!isValidAgentId(req.targetId) || !ws.repo.exists(req.targetId)) {
      throw new ImportError(`No agent '${req.targetId}'`, 404, 'LOUSHO_AGENT_NOT_FOUND');
    }
    return req.targetId;
  }
  if (req.mode === 'copy' && req.targetId !== undefined && !isValidAgentId(req.targetId)) {
    throw new ImportError(`Invalid agent id '${req.targetId}'`, 400, 'LOUSHO_AGENT_ID_INVALID');
  }
  const exists = (id: string) => idTaken(ws, id);
  return req.mode === 'new' ? resolveFreshId(suggestedId, exists) : resolveNextCopyId(req.targetId ?? suggestedId, exists);
}

/** The existing agent `suggestedId` names (its display name), or `null` when the id is free. */
async function clashFor(ws: WorkspaceContext, suggestedId: string): Promise<ImportPreview['clash']> {
  if (!ws.repo.exists(suggestedId)) return null;
  const spec = await ws.repo.readSpec(suggestedId).catch(() => undefined);
  return { id: suggestedId, name: spec?.name ?? suggestedId };
}

/**
 * `POST /agents/import/preview`: parses the text and answers the
 * `ImportPreview` the import sheet renders - spec, labels, clash, the id
 * the requested mode resolves to, readiness rows, bundle prompts and
 * warnings.
 */
// fallow-ignore-next-line unused-export -- contract surface (L08a); L08b's import sheet consumes it
export async function previewImport(req: ImportRequest, ws: WorkspaceContext, deps: ImportDeps): Promise<ImportPreview> {
  const parsed = parseImportText(req.text);
  const suggestedId = slugifyAgentId(parsed.spec.name);
  const [resolvedId, clash, requirements] = await Promise.all([
    resolveImportId(req, ws, suggestedId),
    clashFor(ws, suggestedId),
    computeRequirements(parsed.spec, requirementDeps(ws.ref.root, deps.secrets)),
  ]);
  const warnings = [...parsed.warnings];
  for (const prompt of parsed.prompts) {
    warnings.push(`Prompt '${prompt.name}' will be added to the observe daemon if it is running.`);
  }
  return {
    format: parsed.format,
    spec: parsed.spec,
    labels: parsed.labels,
    suggestedId,
    clash,
    resolvedId,
    requirements,
    prompts: parsed.prompts.map((prompt) => ({ name: prompt.name, version: prompt.version })),
    warnings,
  };
}

/**
 * Best-effort prompt registration: `POST {observeTarget()}/api/v1/prompts`
 * per bundle prompt (the daemon dedupes by hash). Every failure - daemon
 * down, non-2xx, timeout - is ignored: the prompts are listed in the
 * preview's warnings ahead of time.
 */
async function registerPrompts(prompts: AgentBundle['prompts'], deps: ImportDeps): Promise<void> {
  if (prompts.length === 0) return;
  const doFetch = deps.fetch ?? fetch;
  await Promise.all(
    prompts.map(async (prompt) => {
      try {
        await doFetch(`${observeTarget()}/api/v1/prompts`, {
          method: 'POST',
          headers: daemonHeaders(),
          body: JSON.stringify({ name: prompt.name, text: prompt.content }),
          signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
        });
      } catch {
        // Best-effort: a missing daemon never fails the import.
      }
    })
  );
}

/**
 * `POST /agents/import`: writes the parsed spec in `req.mode` and answers
 * the `AgentRecord`. `new`/`copy` mint a disabled agent (`enabled: false`,
 * `createdFrom` import/copy) with a `create`/`import` version; `replace`
 * overwrites `targetId` keeping its enable/publish/disable state, sets
 * labels only for bundle imports, and captures an `update`/`import`
 * version (skipped by the store when the content is unchanged).
 */
export async function runImport(req: ImportRequest, ws: WorkspaceContext, deps: ImportDeps): Promise<AgentRecord> {
  const parsed = parseImportText(req.text);
  const suggestedId = slugifyAgentId(parsed.spec.name);
  const resolvedId = await resolveImportId(req, ws, suggestedId);
  const now = new Date().toISOString();

  await withAgentLock(resolvedId, async () => {
    if (req.mode === 'replace') {
      // Baseline a hand-edited yaml before overwriting it, like PUT does.
      await ws.versions.reconcileExternalEdit(resolvedId);
      await ws.repo.writeSpec(resolvedId, parsed.spec);
      const meta = await ws.repo.readMeta(resolvedId);
      await ws.repo.writeMeta(resolvedId, {
        ...meta,
        labels: parsed.format === 'bundle' ? parsed.labels : meta.labels,
        updatedAt: now,
      });
      await ws.versions.capture(resolvedId, { kind: 'update', source: 'import' });
    } else {
      await ws.repo.writeSpec(resolvedId, parsed.spec);
      const meta: AgentMeta = {
        ...defaultMeta(now),
        enabled: false,
        labels: parsed.labels,
        createdFrom:
          req.mode === 'copy' ? { kind: 'copy', ref: req.targetId ?? suggestedId } : { kind: 'import' },
      };
      await ws.repo.writeMeta(resolvedId, meta);
      await ws.versions.capture(resolvedId, { kind: 'create', source: 'import' });
    }
  });

  await registerPrompts(parsed.prompts, deps);
  ws.events.publish({ type: 'agent.changed', agentId: resolvedId, reason: 'import' });
  const record = await readAgentRecord(ws, resolvedId);
  if (record === undefined) throw new Error(`Agent '${resolvedId}' vanished right after import`);
  return record;
}

/** A validated `POST /agents/import[/preview]` body, or the 400 message. */
function parseImportBody(body: unknown): ImportRequest | string {
  if (!isObject(body)) return 'Request body must be an object';
  if (typeof body.text !== 'string') return "'text' must be a string";
  if (body.mode !== 'new' && body.mode !== 'replace' && body.mode !== 'copy') {
    return "'mode' must be 'new', 'replace' or 'copy'";
  }
  if (body.targetId !== undefined && typeof body.targetId !== 'string') return "'targetId' must be a string";
  return {
    text: body.text,
    mode: body.mode as ImportMode,
    ...(body.targetId !== undefined ? { targetId: body.targetId as string } : {}),
  };
}

/** Maps an {@link ImportError} (or a refused agent chain, R07) onto the response; anything else rethrows to the app's 500 handler. */
function sendImportFailure(res: Response, error: unknown): void {
  if (error instanceof ImportError) {
    sendError(res, error.status, error.message, error.code, error.details);
    return;
  }
  if (error instanceof ChainInvalidError) {
    sendError(res, 400, error.message, error.code, error.cycle !== undefined ? { cycle: error.cycle } : undefined);
    return;
  }
  throw error;
}

/**
 * Registers the two import routes. They MUST be mounted before
 * `registerAgentRoutes`: `POST /agents/import[/preview]` would otherwise
 * be read as agent-id `import` traffic.
 */
export function registerImportRoutes(app: Express, deps: ImportDeps): void {
  app.post(
    '/agents/import/preview',
    asyncRoute(async (req: Request, res: Response) => {
      const parsed = parseImportBody(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      try {
        res.json(await previewImport(parsed, workspaceOf(req), deps));
      } catch (error) {
        sendImportFailure(res, error);
      }
    })
  );

  app.post(
    '/agents/import',
    asyncRoute(async (req: Request, res: Response) => {
      const parsed = parseImportBody(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      try {
        const record = await runImport(parsed, workspaceOf(req), deps);
        res.status(parsed.mode === 'replace' ? 200 : 201).json(record);
      } catch (error) {
        sendImportFailure(res, error);
      }
    })
  );
}
