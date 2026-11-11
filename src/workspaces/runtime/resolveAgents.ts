import { attachmentsSchema, parseAgentRef, type AgentRef, type Attachment } from '../contracts/agentRefs';
import { resolvePageModel, type ResolvedPageModel } from '../contracts/models';
import { pageSchema, type PageManifest } from '../contracts/page';
import { joinPath, normalizeDir } from '../contracts/validateModel';
import { workspaceManifestSchema, type WorkspaceManifest } from '../contracts/workspace';
import { revisionId } from '../source/revision';
import { SDKError } from '../../utils/sdkError';
import { readAgentOwned, type AgentFiles, type AgentOwned } from './agentDirView';
import type { GlobalAgent, GlobalAgentRegistry } from './agentRegistry';
import type { LoadedWorkspace, LoadWorkspaceOptions } from './loadWorkspace';

/** One agent a page attaches, resolved to its files. */
export interface ResolvedAttachment {
  /** The alias the page uses for the agent. */
  alias: string;
  /** The reference as written in `agents.json`. */
  ref: string;
  /** The agent's folder as a workspace-relative path, or the path the global registry reports. */
  dir: string;
  /** What the agent owns: instructions, skills, tools, memory and default model. */
  agentOwned: AgentOwned;
  /** What the page owns: the attachment as written in `agents.json`. */
  pageOwned: Attachment;
  /** The sha256 hex of the agent's files (sorted path and content hash), the same for the same files anywhere. */
  sha256: string;
  /** The version a `global:` ref resolved to; recorded for spans. */
  version?: string;
  /** The model the agent runs with on this page, from `resolvePageModel`. */
  model: ResolvedPageModel;
}

/** Remembers resolved agent dirs for one workspace run; make one with {@link createAgentCache} and pass it for every page of the run. */
export interface AgentCache {
  /** Marks a cache made by `createAgentCache`. */
  readonly kind: 'agent-cache';
}

interface CacheState extends AgentCache {
  agents: Map<string, AgentOwned>;
  dirs: Map<string, { files: Record<string, string>; sha256: string }>;
  globals: Map<string, Promise<GlobalAgent | undefined>>;
}

/** Options of {@link resolveAttachments}. */
export interface ResolveAttachmentsOptions {
  /** Answers `global:` refs; the host injects it. */
  globalRegistry?: GlobalAgentRegistry;
  /** The load mode; `strict` adds nothing yet, the lock is Later (P0.9). */
  mode: LoadWorkspaceOptions['mode'];
  /** The run's cache, so each agent dir is resolved once per run. */
  cache?: AgentCache;
}

/** A fresh {@link AgentCache} for one workspace run. */
export function createAgentCache(): AgentCache {
  const state: CacheState = { kind: 'agent-cache', agents: new Map(), dirs: new Map(), globals: new Map() };
  return state;
}

function stateOf(cache: AgentCache | undefined): CacheState {
  if (cache === undefined) return createAgentCache() as CacheState;
  if (!('globals' in cache)) throw new SDKError('resolveAttachments: pass a cache made by createAgentCache().', 'LOUSHO_VALIDATION_FAILED');
  return cache as CacheState;
}

function unresolved(message: string): SDKError {
  return new SDKError(message, 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED');
}

function doc<T>(workspace: LoadedWorkspace, path: string, schema: { parse(value: unknown): T }): T {
  const raw = workspace.tree[path];
  return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sha256Of(files: Readonly<Record<string, string>>): string {
  return revisionId(new Map(Object.entries(files)));
}

function readTreeDir(workspace: LoadedWorkspace, dir: string): Record<string, string> {
  const prefix = `${dir}/`;
  const paths = Object.keys(workspace.tree).filter((path) => path.startsWith(prefix));
  return Object.fromEntries(paths.map((path) => [path.slice(prefix.length), textOf(workspace.tree[path])]));
}

function treeFiles(workspace: LoadedWorkspace, dir: string, cache: CacheState): { files: Record<string, string>; sha256: string } {
  const key = `${workspace.revision}\0${dir}`;
  const hit = cache.dirs.get(key);
  if (hit !== undefined) return hit;
  const files = readTreeDir(workspace, dir);
  if (Object.keys(files).length === 0) throw unresolved(`agent folder '${dir}' does not exist in the workspace`);
  const entry = { files, sha256: sha256Of(files) };
  cache.dirs.set(key, entry);
  return entry;
}

function owned(cache: CacheState, agent: AgentFiles, sha256: string): AgentOwned {
  const key = `${agent.dir}\0${sha256}`;
  const hit = cache.agents.get(key);
  if (hit !== undefined) return hit;
  const result = readAgentOwned(agent);
  cache.agents.set(key, result);
  return result;
}

interface Located {
  agent: AgentFiles;
  sha256: string;
  version?: string;
}

function globalAgent(ref: Extract<AgentRef, { kind: 'global' }>, options: ResolveAttachmentsOptions, cache: CacheState): Promise<GlobalAgent | undefined> {
  const key = `${ref.name}@${ref.range}`;
  let entry = cache.globals.get(key);
  if (entry === undefined) {
    if (options.globalRegistry === undefined) throw unresolved(`global:${key} needs a globalRegistry; the host injects one`);
    entry = options.globalRegistry.resolve(ref.name, ref.range);
    cache.globals.set(key, entry);
    entry.catch(() => cache.globals.delete(key));
  }
  return entry;
}

async function locateGlobal(ref: Extract<AgentRef, { kind: 'global' }>, options: ResolveAttachmentsOptions, cache: CacheState): Promise<Located> {
  const found = await globalAgent(ref, options, cache);
  if (found === undefined) throw unresolved(`global:${ref.name}@${ref.range} matches no version in the global agent registry`);
  return { agent: { format: found.format, dir: found.dir, files: found.files }, sha256: sha256Of(found.files), version: found.version };
}

interface PageContext {
  workspace: LoadedWorkspace;
  manifest: WorkspaceManifest;
  page: PageManifest;
  pageDir: string;
}

async function locate(context: PageContext, ref: AgentRef, options: ResolveAttachmentsOptions, cache: CacheState): Promise<Located> {
  if (ref.kind === 'global') return locateGlobal(ref, options, cache);
  const base = ref.kind === 'workspace' ? normalizeDir(context.manifest.agents ?? 'agents') : `${context.pageDir}/agents`;
  const dir = `${base}/${ref.name}`;
  const { files, sha256 } = treeFiles(context.workspace, dir, cache);
  return { agent: { format: 'dir', dir, files }, sha256 };
}

async function resolveOne(context: PageContext, attachment: Attachment, options: ResolveAttachmentsOptions, cache: CacheState): Promise<ResolvedAttachment> {
  const parsed = parseAgentRef(attachment.ref);
  if (!parsed.ok) throw unresolved(parsed.error);
  const { agent, sha256, version } = await locate(context, parsed.ref, options, cache);
  const agentOwned = owned(cache, agent, sha256);
  const model = resolvePageModel({
    attachmentModel: attachment.model,
    pageDefault: context.page.defaults?.model,
    agentDefault: agentOwned.defaultModel,
    workspaceDefault: context.manifest.defaults?.model,
    pageProvider: context.page.models?.provider,
    workspaceProvider: context.manifest.models?.provider,
  });
  return { alias: attachment.as, ref: attachment.ref, dir: agent.dir, agentOwned, pageOwned: attachment, sha256, ...(version !== undefined && { version }), model };
}

/** Resolves every agent a page attaches: `workspace:` and `local:` refs to folders in the loaded tree, `global:` refs through the injected registry. Reads files only from the tree or the registry and never imports, copies or writes them. */
export async function resolveAttachments(workspace: LoadedWorkspace, pageId: string, options: ResolveAttachmentsOptions): Promise<ResolvedAttachment[]> {
  const manifest = doc(workspace, 'workspace.json', workspaceManifestSchema);
  if (!manifest.pages.includes(pageId)) throw unresolved(`page '${pageId}' is not listed in workspace.json`);
  const pageDir = `pages/${pageId}`;
  const page = doc(workspace, `${pageDir}/page.json`, pageSchema);
  const agentsPath = joinPath(pageDir, page.agents ?? 'agents.json');
  if (!(agentsPath in workspace.tree)) return [];
  const context: PageContext = { workspace, manifest, page, pageDir };
  const cache = stateOf(options.cache);
  const resolved: ResolvedAttachment[] = [];
  for (const attachment of doc(workspace, agentsPath, attachmentsSchema).agents) resolved.push(await resolveOne(context, attachment, options, cache));
  return resolved;
}
