/**
 * Catalog routes - `GET /catalog/{models,tools,guardrails,triggers,skills,kits}`.
 *
 * The SPA's pickers and the Author read the SDK's catalogs over these routes
 * instead of hard-coding names: `listModels`/`listBuiltinTools`/
 * `listGuardrails`/`listTriggerTypes` straight from the SDK, and the registry
 * index (`<sdkRoot>/registry/dist/index.json`, shipped in the npm package)
 * for skills and kits.
 *
 * Two response details differ from a raw SDK dump:
 *  - A model's `available` also counts a key stored in Studio's
 *    `SecretsStore` (`available = sdk.available || stored key`), so a user
 *    who pasted a key in Settings sees the provider's models as usable even
 *    when the env var is unset.
 *  - A missing or unparsable registry index yields `[]` with one
 *    `console.warn` (never a 500): Studio works without the registry.
 *
 * Tools, guardrails, trigger types and the parsed registry index are
 * memoised per `registerCatalogRoutes` call (static until the next
 * `lousho` upgrade); models are computed per request because stored keys
 * change at runtime. `/catalog/mcp/probe` is a later ticket.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Express } from 'express';
import { listBuiltinTools, listGuardrails, listModels, listTriggerTypes } from 'lousho';
import type {
  CatalogGuardrail,
  CatalogKit,
  CatalogModel,
  CatalogSkill,
  CatalogTool,
  CatalogTriggerType,
} from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import { sdkRootDir } from '../sdkRoot';
import { isSecretProvider, type SecretsStore } from '../secretsStore';

/** Deps for {@link registerCatalogRoutes}. */
export interface CatalogRouteDeps {
  /** Counted toward a model's `available` - the same store Settings writes keys into. */
  secretsStore: SecretsStore;
  /** Defaults to `<sdkRoot>/registry/dist/index.json`. */
  registryIndexPath?: string;
}

/** One `registry/dist/index.json` item that passed the string-fields filter. */
interface RegistryItem {
  name: string;
  type: string;
  description: string;
}

function isRegistryItem(value: unknown): value is RegistryItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && typeof item.type === 'string' && typeof item.description === 'string';
}

/**
 * The registry index parsed once per registration: `[]` plus one
 * `console.warn` on a missing/unparsable file or a non-array `items` -
 * Studio must work without it.
 */
async function readRegistryIndex(indexPath: string): Promise<RegistryItem[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
  } catch (error) {
    console.warn(
      `[catalog] could not read the registry index at ${indexPath}: ${(error as Error).message} - /catalog/skills and /catalog/kits will return [].`
    );
    return [];
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    console.warn(`[catalog] the registry index at ${indexPath} has no 'items' array - /catalog/skills and /catalog/kits will return [].`);
    return [];
  }
  return items.filter(isRegistryItem);
}

/** The `?provider=` filter for `/catalog/models`, or the 400 message when present but empty (or not a single string). */
function parseProvider(query: unknown): { provider?: string; error?: string } {
  if (query === undefined) return {};
  if (typeof query !== 'string' || query.length === 0) return { error: "'provider' must be a non-empty string" };
  return { provider: query };
}

/**
 * Registers the six catalog routes. `deps.secretsStore` only decides the
 * `available` flag on models - keys are never placed in a response body.
 */
export function registerCatalogRoutes(app: Express, deps: CatalogRouteDeps): void {
  const indexPath = deps.registryIndexPath ?? path.join(sdkRootDir(), 'registry', 'dist', 'index.json');
  const registryItems = readRegistryIndex(indexPath);
  const tools: CatalogTool[] = listBuiltinTools();
  const guardrails: CatalogGuardrail[] = listGuardrails();
  const triggerTypes: CatalogTriggerType[] = listTriggerTypes();

  app.get('/catalog/models', (req, res) => {
    const parsed = parseProvider(req.query.provider);
    if (parsed.error !== undefined) {
      sendError(res, 400, parsed.error, 'LOUSHO_QUERY_INVALID');
      return;
    }
    const models: CatalogModel[] = listModels(parsed.provider === undefined ? {} : { provider: parsed.provider }).map((model) => ({
      ...model,
      available:
        model.available ||
        (isSecretProvider(model.provider) && deps.secretsStore.getKey(model.provider) !== undefined),
    }));
    res.json(models);
  });

  app.get('/catalog/tools', (_req, res) => {
    res.json(tools);
  });

  app.get('/catalog/guardrails', (_req, res) => {
    res.json(guardrails);
  });

  app.get('/catalog/triggers', (_req, res) => {
    res.json(triggerTypes);
  });

  app.get(
    '/catalog/skills',
    asyncRoute(async (_req, res) => {
      const skills: CatalogSkill[] = (await registryItems)
        .filter((item) => item.type === 'skill')
        .map((item) => ({ name: item.name, description: item.description, ref: { registry: item.name } }));
      res.json(skills);
    })
  );

  app.get(
    '/catalog/kits',
    asyncRoute(async (_req, res) => {
      const kits: CatalogKit[] = (await registryItems)
        .filter((item) => item.type === 'kit')
        .map((item) => ({ name: item.name, description: item.description }));
      res.json(kits);
    })
  );
}
