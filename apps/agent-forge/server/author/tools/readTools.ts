/**
 * The Author's ten workspace-and-catalog read tools (PLAN §8.2, AA06
 * tools 1-10): `getCurrentSpec` plus the `list*` family over agents,
 * models, builtin tools, guardrails, trigger types, skills, kits,
 * templates and configured MCP servers.
 *
 * Everything here is read-only and returns paged results (paging.ts) so
 * the model can always copy a real id instead of inventing one
 * ("never invent ids - copy from list tools", research §10). Failures
 * are returned in the shared `{ ok:false, code, ... }` shape - the
 * `AGENT_NOT_FOUND` of `getCurrentSpec` and the `UNAVAILABLE` catch-all
 * of `guardedToolCall`.
 */
import { defineTool } from 'lousho';
import { z } from 'zod';
import type { AgentSpecV2 } from 'lousho';
import type { McpServerSpecV2 } from '../../../shared/wireTypes';
import type { WorkspaceContext } from '../../workspace/context';
import { specHash } from '../../storage/specHash';
import { guardedToolCall, toolFailure } from './failure';
import { paginate, pageSchema } from './paging';
import type { AuthorToolFactory, CatalogService } from './index';

/** The `agentId` input the spec-reading tools share. */
const agentIdField = z
  .string()
  .min(1)
  .max(128)
  .describe('Agent id, copied exactly from listAgents or the turn context.');

// ---------------------------------------------------------------------
// 1. getCurrentSpec - the working copy the model edits against.
// ---------------------------------------------------------------------

const getCurrentSpec: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'getCurrentSpec',
    description:
      "Read an agent's current saved spec (the working copy), its enabled state and latest version. Call this before proposing any change.",
    input: z.object({ agentId: agentIdField }),
    execute: ({ agentId }) =>
      guardedToolCall('getCurrentSpec', async () => {
        const { repo, versions } = await deps.workspace();
        const spec = await repo.readSpec(agentId);
        if (spec === undefined) {
          return toolFailure(
            'AGENT_NOT_FOUND',
            `No agent with id "${agentId}".`,
            "That agent doesn't exist.",
            'Call listAgents and copy an id from it.'
          );
        }
        const [meta, latest] = await Promise.all([repo.readMeta(agentId), versions.latest(agentId)]);
        return {
          ok: true,
          agentId,
          spec,
          meta: { enabled: meta.enabled, labels: meta.labels, publishedVersion: meta.publishedVersion },
          latestVersion: latest?.version ?? null,
          specHash: specHash(spec),
        };
      }),
  });

// ---------------------------------------------------------------------
// 2. listAgents - the workspace's agents as { id, name, ... } rows.
// ---------------------------------------------------------------------

const listAgents: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listAgents',
    description: 'List the agents in this Studio workspace.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listAgents', async () => {
        const { repo } = await deps.workspace();
        const rows = await Promise.all(
          repo.listIds().map(async (id) => {
            const [spec, meta] = await Promise.all([repo.readSpec(id), repo.readMeta(id)]);
            if (spec === undefined) return undefined;
            return {
              id,
              name: spec.name,
              description: spec.description ?? '',
              enabled: meta.enabled,
              model: spec.model,
              labels: meta.labels,
            };
          })
        );
        const items = rows.filter((row): row is NonNullable<typeof row> => row !== undefined);
        return paginate(items, input, (item) => [item.id, item.name, item.description]);
      }),
  });

// ---------------------------------------------------------------------
// 3. listModels - the model catalog with provider-key availability.
// ---------------------------------------------------------------------

const listModels: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listModels',
    description: 'List models with their capabilities and whether a key is set for their provider.',
    input: z.object({
      provider: z.string().max(40).optional().describe('Only models from this provider, for example "anthropic".'),
      ...pageSchema,
    }),
    execute: (input) =>
      guardedToolCall('listModels', async () => {
        const items = deps.catalog.listModels(input.provider).map((model) => ({
          id: model.id,
          provider: model.provider,
          contextWindow: model.contextWindow,
          capabilities: model.capabilities,
          available: model.available,
          ...(model.inputCostPerMTok !== undefined && { inputCostPerMTok: model.inputCostPerMTok }),
          ...(model.outputCostPerMTok !== undefined && { outputCostPerMTok: model.outputCostPerMTok }),
        }));
        return paginate(items, input, (item) => [item.id, item.provider]);
      }),
  });

// ---------------------------------------------------------------------
// 4. listTools - builtin tools; inputJsonSchema only on request.
// ---------------------------------------------------------------------

const listTools: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listTools',
    description: 'List builtin tools. Pass names to get their full input schemas.',
    input: z.object({
      names: z
        .array(z.string().max(80).describe('A builtin tool name.'))
        .max(10)
        .optional()
        .describe('Tool names to return in full, with inputJsonSchema.'),
      ...pageSchema,
    }),
    execute: (input) =>
      guardedToolCall('listTools', async () => {
        const catalogTools = deps.catalog.listTools();
        const wanted = new Set(input.names ?? []);
        const known = new Set(catalogTools.map((tool) => tool.name));
        const items = catalogTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          needsCredentials: tool.needsCredentials,
          mutating: tool.mutating,
          ...(wanted.has(tool.name) && { inputJsonSchema: tool.inputJsonSchema }),
        }));
        return {
          ...paginate(items, input, (item) => [item.name, item.description]),
          unknownNames: [...wanted].filter((name) => !known.has(name)),
        };
      }),
  });

// ---------------------------------------------------------------------
// 5-6. listGuardrails / listTriggerTypes - the spec's named options.
// ---------------------------------------------------------------------

const listGuardrails: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listGuardrails',
    description: 'List guardrail types and their options.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listGuardrails', async () => {
        const items = deps.catalog.listGuardrails().map((guardrail) => ({
          name: guardrail.name,
          description: guardrail.description,
          on: guardrail.on,
          optionsJsonSchema: guardrail.optionsJsonSchema,
        }));
        return paginate(items, input, (item) => [item.name, item.description]);
      }),
  });

const listTriggerTypes: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listTriggerTypes',
    description: 'List trigger types, their fields and where they run.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listTriggerTypes', async () => {
        const items = deps.catalog.listTriggerTypes().map((trigger) => ({
          type: trigger.type,
          description: trigger.description,
          fieldsJsonSchema: trigger.fieldsJsonSchema,
          runsUnder: [...trigger.runsUnder],
        }));
        return paginate(items, input, (item) => [item.type, item.description]);
      }),
  });

// ---------------------------------------------------------------------
// 7-9. listSkills / listKits / listTemplates - installable building blocks.
// ---------------------------------------------------------------------

const listSkills: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listSkills',
    description: 'List skills available to attach.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listSkills', async () =>
        paginate(await deps.catalog.listSkills(), input, (item) => [item.name, item.description])
      ),
  });

const listKits: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listKits',
    description: 'List kits (bundles of tools and skills).',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listKits', async () =>
        paginate(await deps.catalog.listKits(), input, (item) => [item.name, item.description])
      ),
  });

const listTemplates: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listTemplates',
    description: 'List agent templates that can seed a new agent.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listTemplates', async () =>
        paginate(await deps.templates.list(), input, (item) => [
          item.id,
          item.title,
          item.description,
          item.category,
          ...item.tags,
        ])
      ),
  });

// ---------------------------------------------------------------------
// 10. listMcpServers - servers configured in any agent + registry entries.
// ---------------------------------------------------------------------

/** One `listMcpServers` row: the server without its secrets - env and header key names only, never values. */
interface McpServerRow {
  key: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  /** Sorted env var names of a stdio server (keys only - values never leave the spec). */
  envKeys?: string[];
  /** Sorted header names of an HTTP server (keys only). */
  headersKeys?: string[];
  /** Agent ids that configure this server (`key` + command/url), sorted. */
  usedBy: string[];
  source: 'agent' | 'registry';
}

/** The dedupe key the ticket fixes: `key` + command/url. */
function dedupeKey(key: string, target: string): string {
  return `${key} ${target}`;
}

/** One spec's `mcpServers.<key>` entry as a row with its secret fields reduced to key names. */
function agentServerRow(key: string, server: McpServerSpecV2): { dedupe: string; row: McpServerRow } {
  if ('command' in server) {
    const envKeys = Object.keys(server.env ?? {}).sort((a, b) => a.localeCompare(b));
    return {
      dedupe: dedupeKey(key, server.command),
      row: {
        key,
        transport: 'stdio',
        command: server.command,
        ...(envKeys.length > 0 && { envKeys }),
        usedBy: [],
        source: 'agent',
      },
    };
  }
  const headersKeys = Object.keys(server.headers ?? {}).sort((a, b) => a.localeCompare(b));
  return {
    dedupe: dedupeKey(key, server.url),
    row: {
      key,
      transport: 'http',
      url: server.url,
      ...(headersKeys.length > 0 && { headersKeys }),
      usedBy: [],
      source: 'agent',
    },
  };
}

/** Every agent's configured servers folded into `byDedupe` (usedBy merges on key + command/url). */
async function collectAgentServers(repo: WorkspaceContext['repo'], byDedupe: Map<string, McpServerRow>): Promise<void> {
  await Promise.all(
    repo.listIds().map(async (id) => {
      const spec: AgentSpecV2 | undefined = await repo.readSpec(id);
      for (const [key, server] of Object.entries(spec?.mcpServers ?? {})) {
        const { dedupe, row } = agentServerRow(key, server);
        const existing = byDedupe.get(dedupe);
        if (existing === undefined) {
          row.usedBy = [id];
          byDedupe.set(dedupe, row);
        } else if (!existing.usedBy.includes(id)) {
          existing.usedBy.push(id);
        }
      }
    })
  );
}

/** Registry `mcp` items not already covered by an agent row (`source: 'registry'`). */
async function collectRegistryServers(catalog: CatalogService, byDedupe: Map<string, McpServerRow>): Promise<void> {
  for (const entry of await catalog.listRegistryMcpServers()) {
    if (entry.command === undefined && entry.url === undefined) continue;
    const target = entry.command ?? (entry.url as string);
    if (byDedupe.has(dedupeKey(entry.key, target))) continue;
    byDedupe.set(dedupeKey(entry.key, target), {
      key: entry.key,
      transport: entry.command !== undefined ? 'stdio' : 'http',
      ...(entry.command !== undefined && { command: entry.command }),
      ...(entry.url !== undefined && { url: entry.url }),
      usedBy: [],
      source: 'registry',
    });
  }
}

const listMcpServers: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'listMcpServers',
    description: 'List MCP servers already configured in any agent, plus known registry entries.',
    input: z.object({ ...pageSchema }),
    execute: (input) =>
      guardedToolCall('listMcpServers', async () => {
        const { repo } = await deps.workspace();
        const byDedupe = new Map<string, McpServerRow>();
        await collectAgentServers(repo, byDedupe);
        await collectRegistryServers(deps.catalog, byDedupe);
        const items = [...byDedupe.values()]
          .map((row) => ({ ...row, usedBy: [...row.usedBy].sort((a, b) => a.localeCompare(b)) }))
          .sort((a, b) => a.key.localeCompare(b.key));
        return paginate(items, input, (item) => [item.key, item.command, item.url]);
      }),
  });

/** AA06's read tools 1-10; probeMcpServer, searchDocs and openPage live in their own files. */
export const readToolFactories: readonly AuthorToolFactory[] = [
  getCurrentSpec,
  listAgents,
  listModels,
  listTools,
  listGuardrails,
  listTriggerTypes,
  listSkills,
  listKits,
  listTemplates,
  listMcpServers,
];
