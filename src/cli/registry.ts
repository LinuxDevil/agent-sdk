/**
 * The registry behind `loushy add` (LOU-D50): a JSON index plus one JSON
 * document per item, at a URL or a local path. Reading is all this does; nothing
 * from a registry is executed or imported. See docs/registry.md.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { SDKError } from '../execution/errors';
import { closestMatch } from '../utils/closestMatch';
import { issueMessage, issuePath, type SafeParser } from '../utils/zodCompat';

const FETCH_TIMEOUT_MS = 15_000;
/** The most a registry document may be, in characters; each file and each item have their own caps in addWrite.ts. */
const MAX_DOCUMENT_CHARS = 2_000_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const itemName = z.string().regex(NAME, 'a name is letters, digits, ".", "_" and "-"');
const itemType = z.enum(['tool', 'skill', 'channel', 'schedule', 'memory']);

const IndexSchema = z.object({
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

const ItemSchema = z.object({
  name: itemName,
  type: itemType,
  description: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  permissions: z
    .object({
      network: z.array(z.string()).optional(),
      env: z.array(z.string()).optional(),
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
  /** `--registry`; the `LOUSHY_REGISTRY` environment variable when absent. */
  registry?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const isHttp = (source: string): boolean => /^https?:\/\//i.test(source);

function unreachable(source: string, reason: string, cause?: unknown): SDKError {
  return new SDKError(`loushy add: cannot read the registry document ${source}: ${reason}`, 'LOUSHY_REGISTRY_UNREACHABLE', { cause });
}

async function fetchText(source: string, options: RegistryOptions): Promise<string> {
  const response = await (options.fetch ?? fetch)(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new SDKError(`HTTP ${response.status}`, 'LOUSHY_REGISTRY_UNREACHABLE');
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
    throw new SDKError(`loushy add: ${source} is not valid JSON.`, 'LOUSHY_REGISTRY_INVALID', { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`).join('; ');
  throw new SDKError(`loushy add: ${source} is not a valid registry document: ${problems}`, 'LOUSHY_REGISTRY_INVALID');
}

/** Where the registry is: `--registry`, else `LOUSHY_REGISTRY`, else a coded error that says how to pass one. */
export function registrySource(options: RegistryOptions): string {
  const source = options.registry ?? (options.env ?? process.env).LOUSHY_REGISTRY;
  if (source) return source;
  throw new SDKError('loushy add: no registry configured; there is no hosted registry yet.', 'LOUSHY_CONFIG_INVALID', {
    hint: 'Pass --registry <url-or-path> to a registry index.json, or set LOUSHY_REGISTRY. See docs/registry.md.',
  });
}

export async function loadIndex(registry: string, options: RegistryOptions): Promise<RegistryIndex> {
  return readJson(registry, IndexSchema, options);
}

/** Resolves an index entry's `url` / `path` against the registry's own location. */
function resolveRef(registry: string, ref: string): string {
  if (isHttp(ref)) return ref;
  if (isHttp(registry)) return new URL(ref, registry).href;
  return path.resolve(path.dirname(registry), ref);
}

/** Finds `name` in the index (a `LOUSHY_REGISTRY_ITEM_NOT_FOUND` with a did-you-mean otherwise) and loads its document. */
export async function loadItem(registry: string, index: RegistryIndex, name: string, options: RegistryOptions): Promise<RegistryItem> {
  const entry = index.items.find((candidate) => candidate.name === name);
  if (!entry) {
    const names = index.items.map((candidate) => candidate.name);
    const suggestion = closestMatch(name, names);
    throw new SDKError(`loushy add: no item named '${name}' in the registry${suggestion ? `. Did you mean '${suggestion}'?` : '.'}`, 'LOUSHY_REGISTRY_ITEM_NOT_FOUND', {
      hint: `Run loushy add --list to see the ${names.length} available item(s).`,
    });
  }
  const item = await readJson(resolveRef(registry, (entry.url ?? entry.path) as string), ItemSchema, options);
  if (item.name !== entry.name || item.type !== entry.type) {
    throw new SDKError(`loushy add: the document for '${entry.name}' says it is ${item.type} '${item.name}'.`, 'LOUSHY_REGISTRY_INVALID');
  }
  return item;
}
