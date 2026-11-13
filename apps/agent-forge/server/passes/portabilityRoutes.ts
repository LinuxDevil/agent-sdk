/**
 * Portability check routes (L09a):
 *
 *   POST /agents/import/portability  { text } -> PortabilityAnalysis
 *   POST /agents/:id/portability                   -> PortabilityAnalysis
 *
 * `/agents/import/portability` is registered FIRST: `import` is a valid
 * agent id, so the literal path must win over `/agents/:id/portability`
 * (the same rule the L08a import routes follow). Both handlers await the
 * `portability_check` pass and answer its `PortabilityAnalysis`; per-agent
 * stores come from `workspaceOf(req)` (the workspace seam), the
 * Studio-global secrets/settings stores from the registration deps.
 */
import type { Express, Request, Response } from 'express';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { ImportError, parseImportText } from '../lifecycle/import';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import type { WorkspaceContext } from '../workspace/context';
import { workspaceOf } from '../workspace/middleware';
import { checkPortability, PortabilityError, type PortabilityDeps } from './portability';

/** The Studio-global stores the portability routes need (per-workspace stores come from `workspaceOf(req)`). */
export interface PortabilityRouteDeps {
  secretsStore: SecretsStore;
  settings: SettingsStore;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The pass deps one request's workspace context plus the Studio-global stores make. */
function depsFor(ws: WorkspaceContext, globals: PortabilityRouteDeps): PortabilityDeps {
  return {
    passRunner: ws.passes,
    suggestions: ws.suggestions,
    secretsStore: globals.secretsStore,
    settings: globals.settings,
    workspaceId: ws.ref.id,
  };
}

/** Runs the check for `spec` and answers the analysis; maps the pass/import failures onto the response. */
async function sendAnalysis(
  res: Response,
  spec: AgentSpecV2,
  agentId: string | null,
  ws: WorkspaceContext,
  globals: PortabilityRouteDeps
): Promise<void> {
  try {
    res.json(await checkPortability(spec, agentId, depsFor(ws, globals)));
  } catch (error) {
    sendCheckFailure(res, error);
  }
}

/** Maps a {@link PortabilityError}/{@link ImportError} onto the response; anything else rethrows to the 500 handler. */
function sendCheckFailure(res: Response, error: unknown): void {
  if (error instanceof PortabilityError) {
    sendError(res, error.status, error.message, error.code);
    return;
  }
  if (error instanceof ImportError) {
    sendError(res, error.status, error.message, error.code, error.details);
    return;
  }
  throw error;
}

/** A validated `{ text }` import-portability body, or the 400 message (same shape as `parseImportBody`). */
function parseTextBody(body: unknown): { text: string } | string {
  if (!isObject(body)) return 'Request body must be an object';
  if (typeof body.text !== 'string') return "'text' must be a string";
  return { text: body.text };
}

/**
 * Registers both portability routes. `/agents/import/portability` MUST be
 * mounted before `/agents/:id/portability` (and both before
 * `registerAgentRoutes`): `import` is a valid agent id.
 */
export function registerPortabilityRoutes(app: Express, deps: PortabilityRouteDeps): void {
  app.post(
    '/agents/import/portability',
    asyncRoute(async (req: Request, res: Response) => {
      const body = parseTextBody(req.body);
      if (typeof body === 'string') {
        sendError(res, 400, body, 'LOUSHO_BODY_INVALID');
        return;
      }
      try {
        const parsed = parseImportText(body.text);
        await sendAnalysis(res, parsed.spec, null, workspaceOf(req), deps);
      } catch (error) {
        sendCheckFailure(res, error);
      }
    })
  );

  app.post(
    '/agents/:id/portability',
    asyncRoute(async (req: Request, res: Response) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const spec = await ws.repo.readSpec(id);
      if (spec === undefined) {
        sendError(res, 404, `No agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
        return;
      }
      await sendAnalysis(res, spec, id, ws, deps);
    })
  );
}
