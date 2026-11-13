/**
 * `computeRequirements(spec, deps)` - the readiness list of a spec v2
 * (PLAN §8.5): what the agent needs before it can run - a provider API
 * key, named secrets and env vars its `{ secret }`/`{ env }` refs resolve
 * to, its models in the catalog, its MCP servers (unprobed: `unknown`),
 * its builtin/registry tools and its local files. Every row is `ok`,
 * `missing` or `unknown` and carries the fix that makes it `ok` where one
 * exists.
 *
 * The whole computation is advisory: it never throws (an internal error
 * logs one line and returns `[]`) and never blocks a save. Labels name
 * secrets and variables, never values - no stored or env secret ever
 * appears in output.
 *
 * Deps are injected so tests pass fixtures and the route builds them per
 * call from the request's workspace (`requirementDeps(ws.ref.root,
 * secrets)`): `fileExists` resolves under that workspace's root, not the
 * launch dir, and refuses paths that would escape it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listBuiltinTools, listModels, type AgentSpecV2 } from '@linuxdevil/lousho';
import type { Requirement } from '../../shared/authorWire';
import { isSecretProvider, PROVIDER_KEY_ENV, type SecretProvider, type SecretsStore } from '../secretsStore';

/** Everything `computeRequirements` reads, injectable per call. */
export interface RequirementDeps {
  /** The Studio secrets store, projected to the two reads requirements needs. */
  secrets: {
    /** A stored provider key (`undefined` when unset); `provider` is one Studio manages (`openai`/`anthropic`). */
    getKey(provider: string): string | undefined;
    /** Whether a named secret exists in the store (`SecretsStore.getSecret` in the merged code). */
    hasNamed(name: string): boolean;
  };
  /** `process.env` in production, a fixture in tests. */
  env: Readonly<Record<string, string | undefined>>;
  /** The SDK catalogs (D09): 'provider/model' ids and the builtin tool table. */
  catalog: {
    modelIds(): Promise<ReadonlySet<string>>;
    builtinTools(): Promise<ReadonlyArray<{ name: string; needsCredentials: string[] }>>;
  };
  /** Whether an agentDir-relative path exists under the workspace root; `false` on any error or escape. */
  fileExists(relPath: string): boolean;
}

/** Status order: what needs attention first, then unknown, then ok. */
const STATUS_RANK: Record<Requirement['status'], number> = { missing: 0, unknown: 1, ok: 2 };

/** The fix every missing provider-key row carries: open Settings. */
const SETTINGS_FIX = { action: 'open_settings', target: '/settings' } as const;

/** Providers that need no credential at all (local or the test provider): they produce no row. */
const KEYLESS_PROVIDERS = new Set(['ollama', 'mock']);

/** Labels for the providers Studio stores keys for (the `PROVIDER_KEY_ENV` pair). */
const MANAGED_PROVIDER_LABELS: Record<SecretProvider, string> = {
  openai: 'OpenAI API key',
  anthropic: 'Anthropic API key',
};

/** Env-keyed providers outside `PROVIDER_KEY_ENV` (Studio stores no key for them), from PROVIDERS in src/providers/providerSpec.ts. */
const ENV_KEYED_PROVIDERS: Record<string, { envKey: string; label: string }> = {
  openrouter: { envKey: 'OPENROUTER_API_KEY', label: 'OpenRouter API key' },
  google: { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', label: 'Google API key' },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a < b` / `a > b` as -1 / 0 / 1: code-point order, so sorting never depends on the locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The provider of a 'provider/model' string: the text before the first `/` (the whole string when there is none). */
function providerOf(model: string): string {
  const slash = model.indexOf('/');
  return slash < 0 ? model : model.slice(0, slash);
}

/** Every distinct model string the spec runs on: `model` first, then its fallbacks. */
function modelIdsOf(spec: AgentSpecV2): string[] {
  return [spec.model, ...(spec.fallbackModels ?? [])];
}

// ---------------------------------------------------------------------
// provider_key rows: one per distinct provider of model + fallbackModels.
// ---------------------------------------------------------------------

/** One provider's row, or `undefined` for a provider that needs no key. */
function providerRow(provider: string, deps: RequirementDeps): Requirement | undefined {
  if (KEYLESS_PROVIDERS.has(provider)) return undefined;
  if (isSecretProvider(provider)) {
    const ok = Boolean(deps.secrets.getKey(provider)) || Boolean(deps.env[PROVIDER_KEY_ENV[provider]]);
    return {
      id: `provider:${provider}`,
      kind: 'provider_key',
      status: ok ? 'ok' : 'missing',
      label: MANAGED_PROVIDER_LABELS[provider],
      fix: { ...SETTINGS_FIX },
    };
  }
  const envKeyed = ENV_KEYED_PROVIDERS[provider];
  if (envKeyed !== undefined) {
    return {
      id: `provider:${provider}`,
      kind: 'provider_key',
      status: deps.env[envKeyed.envKey] ? 'ok' : 'missing',
      label: envKeyed.label,
      fix: { ...SETTINGS_FIX },
    };
  }
  return { id: `provider:${provider}`, kind: 'provider_key', status: 'unknown', label: `${provider} provider` };
}

/** `provider:<p>` rows for every provider `model`/`fallbackModels` name. */
function providerRows(spec: AgentSpecV2, deps: RequirementDeps): Requirement[] {
  const providers = new Set(modelIdsOf(spec).map(providerOf));
  const rows: Requirement[] = [];
  for (const provider of providers) {
    const row = providerRow(provider, deps);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------
// model rows: a model the catalog does not know, unknown.
// ---------------------------------------------------------------------

/** `model:<id>` rows for `model`/`fallbackModels` absent from `modelIds`. */
function modelRows(spec: AgentSpecV2, modelIds: ReadonlySet<string>): Requirement[] {
  return modelIdsOf(spec)
    .filter((model) => !modelIds.has(model))
    .map((model) => ({
      id: `model:${model}`,
      kind: 'model' as const,
      status: 'unknown' as const,
      label: `Model ${model} is not in the catalog`,
    }));
}

// ---------------------------------------------------------------------
// secret/env rows: a deep walk of the spec for `{ secret }` / `{ env }` refs.
// ---------------------------------------------------------------------

/** The SecretRef names found so far in a deep walk. */
interface FoundRefs {
  secrets: Set<string>;
  envs: Set<string>;
}

/**
 * Every `{ secret: NAME }`/`{ env: VAR }` ref under `value`: a plain object
 * with exactly one of those keys and a string value is a ref, everything
 * else is recursed into - except `instructions`, which is prose (a prompt
 * file ref is `{ file }`, never a secret) and is never walked.
 */
function collectSecretRefs(value: unknown, found: FoundRefs): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSecretRefs(item, found);
    return;
  }
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'secret' && typeof value['secret'] === 'string') {
    found.secrets.add(value['secret']);
    return;
  }
  if (keys.length === 1 && keys[0] === 'env' && typeof value['env'] === 'string') {
    found.envs.add(value['env']);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'instructions') continue;
    collectSecretRefs(child, found);
  }
}

/** `secret:<NAME>` and `env:<VAR>` rows for every SecretRef the spec carries. */
function secretRefRows(spec: AgentSpecV2, deps: RequirementDeps): Requirement[] {
  const found: FoundRefs = { secrets: new Set(), envs: new Set() };
  collectSecretRefs(spec, found);
  const rows: Requirement[] = [];
  for (const name of found.secrets) {
    rows.push({
      id: `secret:${name}`,
      kind: 'secret',
      status: deps.secrets.hasNamed(name) ? 'ok' : 'missing',
      label: `Secret ${name}`,
      fix: { action: 'add_secret', target: name },
    });
  }
  for (const name of found.envs) {
    rows.push({
      id: `env:${name}`,
      kind: 'secret',
      status: deps.env[name] ? 'ok' : 'missing',
      label: `Environment variable ${name}`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// mcp rows: one unknown row per configured server (probing is the fix's job).
// ---------------------------------------------------------------------

/** `mcp:<key>` rows for each `mcpServers` entry - `unknown`: the card's Check button probes on demand. */
function mcpRows(spec: AgentSpecV2): Requirement[] {
  return Object.keys(spec.mcpServers ?? {}).map((key) => ({
    id: `mcp:${key}`,
    kind: 'mcp' as const,
    status: 'unknown' as const,
    label: `MCP server ${key}`,
    fix: { action: 'probe' as const, target: key },
  }));
}

// ---------------------------------------------------------------------
// tool rows: builtin membership + credentials, registry installs.
// ---------------------------------------------------------------------

/** The credential rows of one catalog-known builtin (one per `needsCredentials` entry). */
function credentialRows(name: string, needsCredentials: readonly string[], deps: RequirementDeps): Requirement[] {
  return needsCredentials.map((cred) => {
    const ok = Boolean(deps.env[cred]) || deps.secrets.hasNamed(cred);
    return {
      id: `tool:${name}:${cred}`,
      kind: 'tool' as const,
      status: ok ? ('ok' as const) : ('missing' as const),
      label: `${cred} for ${name}`,
      fix: { action: 'add_secret' as const, target: cred },
    };
  });
}

/** `tool:<name>`/`tool:<name>:<cred>` rows for builtins and `registry:<name>` rows for registry tools. */
function toolRows(
  spec: AgentSpecV2,
  deps: RequirementDeps,
  tools: ReadonlyArray<{ name: string; needsCredentials: string[] }>
): Requirement[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const rows: Requirement[] = [];
  for (const ref of spec.tools ?? []) {
    if ('builtin' in ref && typeof ref.builtin === 'string') {
      const entry = byName.get(ref.builtin);
      if (entry === undefined) {
        rows.push({
          id: `tool:${ref.builtin}`,
          kind: 'tool',
          status: 'missing',
          label: `Tool ${ref.builtin} is not available`,
        });
      } else {
        rows.push(...credentialRows(ref.builtin, entry.needsCredentials, deps));
      }
    } else if ('registry' in ref && typeof ref.registry === 'string') {
      rows.push({
        id: `registry:${ref.registry}`,
        kind: 'tool',
        status: 'unknown',
        label: `Registry tool ${ref.registry}`,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// file rows: tools[i].file, hooks[i].file and skills[i].dir under the root.
// ---------------------------------------------------------------------

/** Every agentDir-relative path the spec references, in spec order. */
function filePathsOf(spec: AgentSpecV2): string[] {
  const paths: string[] = [];
  for (const ref of spec.tools ?? []) {
    if ('file' in ref && typeof ref.file === 'string') paths.push(ref.file);
  }
  for (const hook of spec.hooks ?? []) {
    if ('file' in hook) paths.push(hook.file);
  }
  for (const skill of spec.skills ?? []) {
    if ('dir' in skill) paths.push(skill.dir);
  }
  return paths;
}

/** `file:<path>` rows for every local path the spec references. */
function fileRows(spec: AgentSpecV2, deps: RequirementDeps): Requirement[] {
  return filePathsOf(spec).map((relPath) => ({
    id: `file:${relPath}`,
    kind: 'tool' as const,
    status: deps.fileExists(relPath) ? ('ok' as const) : ('missing' as const),
    label: `File ${relPath}`,
  }));
}

/**
 * The spec's readiness rows, sorted `missing`, `unknown`, `ok` then by id,
 * deduped by id (a secret referenced twice is one row). Never throws: an
 * internal error logs one line and returns `[]`.
 */
export async function computeRequirements(spec: AgentSpecV2, deps: RequirementDeps): Promise<Requirement[]> {
  try {
    const [modelIds, tools] = await Promise.all([deps.catalog.modelIds(), deps.catalog.builtinTools()]);
    const rows = [
      ...providerRows(spec, deps),
      ...modelRows(spec, modelIds),
      ...secretRefRows(spec, deps),
      ...mcpRows(spec),
      ...toolRows(spec, deps, tools),
      ...fileRows(spec, deps),
    ];
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || cmp(a.id, b.id));
  } catch (error) {
    console.warn(`[agent-forge] computeRequirements failed: ${(error as Error).message}`);
    return [];
  }
}

/**
 * The production {@link RequirementDeps} for one workspace: the app's
 * secrets store (provider keys via `getKey`, named secrets via the merged
 * `getSecret` - the ticket's `hasNamed`), `process.env`, the SDK's own
 * `listModels`/`listBuiltinTools` catalogs, and a `fileExists` that
 * resolves `relPath` under `root` and reports `false` for anything that
 * would escape it (`../..`, absolute paths) - such a path is `missing`,
 * never stat-ed outside the workspace.
 */
export function requirementDeps(root: string, secrets: SecretsStore): RequirementDeps {
  const base = path.resolve(root);
  return {
    secrets: {
      getKey: (provider) => (isSecretProvider(provider) ? secrets.getKey(provider) : undefined),
      hasNamed: (name) => secrets.getSecret(name) !== undefined,
    },
    env: process.env,
    catalog: {
      modelIds: async () => new Set(listModels().map((model) => model.id)),
      builtinTools: async () => listBuiltinTools(),
    },
    fileExists: (relPath) => {
      const abs = path.resolve(base, relPath);
      return (abs === base || abs.startsWith(base + path.sep)) && fs.existsSync(abs);
    },
  };
}
