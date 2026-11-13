/**
 * The concrete {@link CatalogService} the app's Author tools run on:
 * the same SDK catalogs `GET /catalog/*` serves (D09), with a model's
 * `available` also counting the Studio-stored provider keys, and the
 * registry index read once for skills, kits and `type: 'mcp'` entries
 * (shared with the route's reader so the two never parse it
 * differently).
 */
import * as path from 'node:path';
import { listBuiltinTools, listGuardrails, listModels, listTriggerTypes } from '@linuxdevil/lousho';
import { sdkRootDir } from '../../sdkRoot';
import type { SecretsStore } from '../../secretsStore';
import { readRegistryIndex, withStoredKeyAvailability } from '../../routes/catalogRoutes';
import type { CatalogService } from './index';

/**
 * Builds the Author's catalog service over the app's secrets store.
 * `registryIndexPath` overrides the registry index location (tests);
 * the default is the route's own `<sdkRoot>/registry/dist/index.json`.
 * Tools, guardrails, trigger types and the index are static per SDK
 * build, so they are read once here; models are computed per call
 * because stored keys change at runtime.
 */
export function createAuthorCatalogService(deps: {
  secretsStore: SecretsStore;
  registryIndexPath?: string;
}): CatalogService {
  const indexPath = deps.registryIndexPath ?? path.join(sdkRootDir(), 'registry', 'dist', 'index.json');
  const registryItems = readRegistryIndex(indexPath);
  const tools = listBuiltinTools();
  const guardrails = listGuardrails();
  const triggerTypes = listTriggerTypes();
  return {
    listModels: (provider) =>
      withStoredKeyAvailability(listModels(provider === undefined ? {} : { provider }), deps.secretsStore),
    listTools: () => tools,
    listGuardrails: () => guardrails,
    listTriggerTypes: () => triggerTypes,
    listSkills: async () =>
      (await registryItems)
        .filter((item) => item.type === 'skill')
        .map((item) => ({ name: item.name, description: item.description, ref: { registry: item.name } })),
    listKits: async () =>
      (await registryItems)
        .filter((item) => item.type === 'kit')
        .map((item) => ({ name: item.name, description: item.description })),
    listRegistryMcpServers: async () =>
      (await registryItems)
        .filter((item) => item.type === 'mcp')
        .map((item) => ({
          key: item.name,
          ...(typeof item.command === 'string' && { command: item.command }),
          ...(typeof item.url === 'string' && { url: item.url }),
        }))
        .filter((entry) => entry.command !== undefined || entry.url !== undefined),
  };
}
