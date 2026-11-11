import { createHash } from 'node:crypto';
import { readBaseHarness, type HarnessLayer } from '../contracts/baseHarness';
import { composeHarness, type EffectiveHarness } from '../contracts/compose';
import { harnessSchema, type Harness } from '../contracts/harness';
import { pageSchema } from '../contracts/page';
import { inlineSchemas, joinPath, normalizeDir, subtree } from '../contracts/validateModel';
import { workspaceManifestSchema } from '../contracts/workspace';
import type { LoadedWorkspace } from './loadWorkspace';
import { invalid, jsonOf, layerOf, parsedFiles, workspaceProfiles, type ProfileStore } from './profileStore';

/** Composed harnesses keyed by the hashes of their layers; pass a `new Map()` to {@link resolvePageHarness}. It gains an entry per edit, so a long-running host should bound it. */
export type HarnessCache = Map<string, EffectiveHarness>;

/** Options of {@link resolvePageHarness}. */
export interface ResolveHarnessOptions {
  /** Reuses a composed harness when every layer hashes the same. */
  cache?: HarnessCache;
}

const EMPTY_HARNESS: Harness = { schema: 'lousho.harness/1' };

function failNoGlobal(ref: string): never {
  throw invalid(`'${ref}' needs a global profile store, but no global profile store was given`);
}

/** The profile store of a loaded workspace: its own `harness-profiles/` folder, plus `global` for `global:<path>@<range>` refs when given. */
export function profileStoreFor(workspace: LoadedWorkspace, global?: ProfileStore): ProfileStore {
  const manifest = workspaceManifestSchema.parse(jsonOf(workspace.tree['workspace.json'], 'workspace.json'));
  const local = workspaceProfiles(workspace.tree, manifest.harnessProfiles ?? 'harness-profiles');
  const remote = global ?? { get: (ref: string): HarnessLayer => failNoGlobal(ref) };
  return { get: (ref) => (ref.startsWith('global:') ? remote.get(ref) : local.get(ref)) };
}

function baseLayer(workspace: LoadedWorkspace): HarnessLayer | undefined {
  const { layer, problems } = readBaseHarness(workspace.tree);
  if (problems.length > 0) throw invalid(problems.map((item) => `${item.path}: ${item.message}`).join('\n'));
  if (!layer) return undefined;
  const manifest = workspaceManifestSchema.parse(jsonOf(workspace.tree['workspace.json'], 'workspace.json'));
  const files = subtree(workspace.tree, normalizeDir(manifest.harness ?? 'harness'));
  return { ...layer, harness: inlineSchemas(layer.harness, parsedFiles(files)) };
}

function pageLayer(workspace: LoadedWorkspace, pageId: string): HarnessLayer {
  const dir = `pages/${pageId}`;
  const pagePath = `${dir}/page.json`;
  if (!(pagePath in workspace.tree)) throw invalid(`the workspace has no page '${pageId}'`);
  const page = pageSchema.parse(jsonOf(workspace.tree[pagePath], pagePath));
  const harnessPath = joinPath(joinPath(dir, page.harness.overrides ?? 'harness'), 'harness.json');
  const document = harnessPath in workspace.tree ? harnessSchema.parse(jsonOf(workspace.tree[harnessPath], harnessPath)) : EMPTY_HARNESS;
  return layerOf('page', subtree(workspace.tree, dir), { ...document, extends: page.harness.extends }, harnessPath);
}

function collectProfiles(refs: readonly string[], store: ProfileStore, seen: Set<string>, out: HarnessLayer[]): void {
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const layer = store.get(ref);
    collectProfiles(layer.harness.extends ?? [], store, seen, out);
    out.push(layer);
  }
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function cacheKey(layers: readonly HarnessLayer[]): string {
  return hashOf(layers.map((layer) => hashOf([layer.source, layer.harness, layer.texts])));
}

/** Resolves one page's effective harness: the workspace base harness, then each `extends` profile depth first, then the page's own harness, composed by `composeHarness`. Each layer's source is its ref exactly as written, so the hash changes when a ref's range does. */
export function resolvePageHarness(workspace: LoadedWorkspace, pageId: string, store: ProfileStore, options: ResolveHarnessOptions = {}): EffectiveHarness {
  const own = pageLayer(workspace, pageId);
  const profiles: HarnessLayer[] = [];
  collectProfiles(own.harness.extends ?? [], store, new Set(), profiles);
  const base = baseLayer(workspace);
  const layers = [...(base ? [base] : []), ...profiles, own];
  const key = options.cache ? cacheKey(layers) : undefined;
  const cached = key === undefined ? undefined : options.cache?.get(key);
  if (cached) return cached;
  const effective = composeHarness(layers);
  if (key !== undefined) options.cache?.set(key, effective);
  return effective;
}

function layerLines(effective: EffectiveHarness, source: string, index: number): string[] {
  const fields = Object.entries(effective.provenance)
    .filter(([, sources]) => sources.includes(source))
    .map(([path]) => `  ${path}`);
  return ['', `Layer ${index + 1}`, source, ...(fields.length > 0 ? fields : ['  (no values survive)'])];
}

/** A plain-text report of an effective harness: its hash, then each layer in applied order with the fields whose value it supplied. */
export function explainHarness(effective: EffectiveHarness): string {
  const lines = [`Effective harness ${effective.hash}`, `${effective.sources.length} layers, applied in order; a later layer wins per field.`];
  effective.sources.forEach((source, index) => lines.push(...layerLines(effective, source, index)));
  return `${lines.join('\n')}\n`;
}
