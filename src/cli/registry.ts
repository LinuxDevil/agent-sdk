/**
 * The registry behind `lousho add` (LOU-D50): a JSON index plus one JSON
 * document per item, at a URL or a local path. Reading is all this does; nothing
 * from a registry is executed or imported. See docs/registry.md.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { SDKError } from '../execution/errors';
import { isHostPattern } from '../security/hostPattern';
import { closestMatch } from '../utils/closestMatch';
import { issueMessage, issuePath, type SafeParser } from '../utils/zodCompat';

const FETCH_TIMEOUT_MS = 15_000;
/** The most a registry document may be, in characters; each file and each item have their own caps in addWrite.ts. */
const MAX_DOCUMENT_CHARS = 2_000_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;

const itemName = z.string().regex(NAME, 'a name is letters, digits, ".", "_" and "-"');
const itemType = z.enum(['tool', 'skill', 'channel', 'schedule', 'memory', 'kit']);

/**
 * The registry `lousho add` reads when neither `--registry` nor `LOUSHO_REGISTRY`
 * points at one (M7b): the `registry/dist/` folder of this repository, hosted as
 * static JSON. One constant so the hosting answer (issue #230) is a one-line change.
 */
export const DEFAULT_REGISTRY = 'https://registry.lousho.com/index.json';

/**
 * Where the default registry is read from when `DEFAULT_REGISTRY` cannot be
 * reached: the same committed `registry/dist/` folder, served raw from the
 * repository's main branch. Only the default falls back; an explicit
 * `--registry` or `LOUSHO_REGISTRY` never does.
 */
export const DEFAULT_REGISTRY_FALLBACK = 'https://raw.githubusercontent.com/LinuxDevil/agent-sdk/main/registry/dist/index.json';

/** The registry index document; also what `scripts/build-registry.ts` writes as `registry/dist/index.json`. */
export const IndexSchema = z.object({
  items: z.array(
    z
      .object({
        name: itemName,
        type: itemType,
        description: z.string(),
        url: z.string().optional(),
        path: z.string().optional(),
      })
      .refine((item) => item.url !== undefined || item.path !== undefined, 'an item needs a `url` or a `path`')
  ),
});

/** One registry item document; `scripts/build-registry.ts` validates every `registry/dist/items/<name>.json` against it. */
export const ItemSchema = z.object({
  name: itemName,
  type: itemType,
  description: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  permissions: z
    .object({
      network: z.array(z.string().refine(isHostPattern, 'a network entry is a host name or a `*.` wildcard (no scheme, port or path)')).optional(),
      env: z.array(z.string().regex(ENV_VAR, 'an env entry is an environment variable name (A-Z, 0-9 and _)')).optional(),
      filesystem: z.enum(['none', 'read', 'write']).optional(),
      exec: z.boolean().optional(),
      needsApproval: z.boolean().optional(),
    })
    .default({}),
  dependencies: z.array(z.string()).optional(),
});

export type RegistryIndex = z.infer<typeof IndexSchema>;
export type RegistryItem = z.infer<typeof ItemSchema>;

export interface RegistryOptions {
  /** `--registry`; the `LOUSHO_REGISTRY` environment variable when absent. */
  registry?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const isHttp = (source: string): boolean => /^https?:\/\//i.test(source);

function unreachable(source: string, reason: string, cause?: unknown): SDKError {
  return new SDKError(`lousho add: cannot read the registry document ${source}: ${reason}`, 'LOUSHO_REGISTRY_UNREACHABLE', { cause });
}

async function fetchText(source: string, options: RegistryOptions): Promise<string> {
  const response = await (options.fetch ?? fetch)(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new SDKError(`HTTP ${response.status}`, 'LOUSHO_REGISTRY_UNREACHABLE');
  return response.text();
}

/** The text of a registry document, from an `http(s)` URL (with a timeout) or a local path. */
async function readSource(source: string, options: RegistryOptions): Promise<string> {
  if (!isHttp(source) && /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(source)) {
    throw unreachable(source, 'only http(s) URLs and local paths are supported.');
  }
  let text: string;
  try {
    text = isHttp(source) ? await fetchText(source, options) : await readFile(source, 'utf8');
  } catch (error) {
    throw unreachable(source, error instanceof Error ? error.message : String(error), error);
  }
  if (text.length > MAX_DOCUMENT_CHARS) throw unreachable(source, `larger than ${MAX_DOCUMENT_CHARS} characters.`);
  return text;
}

async function readJson<T>(source: string, schema: SafeParser<T>, options: RegistryOptions): Promise<T> {
  const text = await readSource(source, options);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SDKError(`lousho add: ${source} is not valid JSON.`, 'LOUSHO_REGISTRY_INVALID', { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`).join('; ');
  throw new SDKError(`lousho add: ${source} is not a valid registry document: ${problems}`, 'LOUSHO_REGISTRY_INVALID');
}

/**
 * Where the registry is: `--registry`, else `LOUSHO_REGISTRY`, else
 * `DEFAULT_REGISTRY`. `'none'` (either source) disables the registry for
 * offline or locked-down use and restores the "no registry configured" error.
 */
function registrySource(options: RegistryOptions): string {
  const source = options.registry ?? (options.env ?? process.env).LOUSHO_REGISTRY;
  if (source === 'none') {
    throw new SDKError("lousho add: no registry configured ('none' disables the default registry).", 'LOUSHO_CONFIG_INVALID', {
      hint: 'Pass --registry <url-or-path> to a registry index.json, or set LOUSHO_REGISTRY. See docs/registry.md.',
    });
  }
  return source || DEFAULT_REGISTRY;
}

async function loadIndex(registry: string, options: RegistryOptions): Promise<RegistryIndex> {
  return readJson(registry, IndexSchema, options);
}

/**
 * Loads the index of the configured registry (see `registrySource`) and
 * returns it with the location that answered, which item references resolve
 * against. The default registry falls back to `DEFAULT_REGISTRY_FALLBACK`
 * when its host is unreachable.
 */
export async function openRegistry(options: RegistryOptions): Promise<{ registry: string; index: RegistryIndex }> {
  const registry = registrySource(options);
  try {
    return { registry, index: await loadIndex(registry, options) };
  } catch (error) {
    if (registry !== DEFAULT_REGISTRY || !(error instanceof SDKError) || error.code !== 'LOUSHO_REGISTRY_UNREACHABLE') throw error;
    try {
      return { registry: DEFAULT_REGISTRY_FALLBACK, index: await loadIndex(DEFAULT_REGISTRY_FALLBACK, options) };
    } catch (fallbackError) {
      if (!(fallbackError instanceof SDKError) || fallbackError.code !== 'LOUSHO_REGISTRY_UNREACHABLE') throw fallbackError;
      const reason = (e: SDKError) => e.detail.replace(/^lousho add: /, '');
      throw new SDKError(
        `lousho add: the default registry is unreachable: ${reason(error)}; and its fallback: ${reason(fallbackError)}`,
        'LOUSHO_REGISTRY_UNREACHABLE',
        { cause: fallbackError, hint: 'Check that you are online, or pass --registry <url-or-path> (e.g. a local copy of registry/dist/index.json).' }
      );
    }
  }
}

/** Resolves an index entry's `url` / `path` against the registry's own location. */
function resolveRef(registry: string, ref: string): string {
  if (isHttp(ref)) return ref;
  if (isHttp(registry)) return new URL(ref, registry).href;
  return path.resolve(path.dirname(registry), ref);
}

/** Finds `name` in the index (a `LOUSHO_REGISTRY_ITEM_NOT_FOUND` with a did-you-mean otherwise) and loads its document. */
export async function loadItem(registry: string, index: RegistryIndex, name: string, options: RegistryOptions): Promise<RegistryItem> {
  const entry = index.items.find((candidate) => candidate.name === name);
  if (!entry) {
    const names = index.items.map((candidate) => candidate.name);
    const suggestion = closestMatch(name, names);
    throw new SDKError(`lousho add: no item named '${name}' in the registry${suggestion ? `. Did you mean '${suggestion}'?` : '.'}`, 'LOUSHO_REGISTRY_ITEM_NOT_FOUND', {
      hint: `Run lousho add --list to see the ${names.length} available item(s).`,
    });
  }
  const item = await readJson(resolveRef(registry, (entry.url ?? entry.path) as string), ItemSchema, options);
  if (item.name !== entry.name || item.type !== entry.type) {
    throw new SDKError(`lousho add: the document for '${entry.name}' says it is ${item.type} '${item.name}'.`, 'LOUSHO_REGISTRY_INVALID');
  }
  return item;
}
