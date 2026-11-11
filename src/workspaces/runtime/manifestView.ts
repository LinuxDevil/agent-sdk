import { attachmentsSchema } from '../contracts/agentRefs';
import type { WorkspaceTree } from '../contracts/baseHarness';
import { pageSchema, type PageManifest } from '../contracts/page';
import { SHARED_FOLDERS } from '../contracts/shared';
import { joinPath, normalizeDir } from '../contracts/validateModel';
import { workspaceManifestSchema } from '../contracts/workspace';

/** One agent a page attaches. */
export interface AttachmentView {
  /** The alias the page uses for the agent. */
  alias: string;
  /** The reference as written in `agents.json`. */
  ref: string;
  /** Where the reference points: `workspace`, `local` or `global`. */
  kind: 'workspace' | 'local' | 'global';
}

/** What a page takes from the rest of the workspace. */
export interface PageInheritsView {
  /** The base harness folder, when the workspace has one. */
  base?: string;
  /** The `shared/` subfolders that exist in the workspace. */
  shared: string[];
  /** The harness profiles the page extends, by ref as written. */
  profiles: string[];
}

/** One page: what it owns and what it inherits. */
export interface PageManifestView {
  /** The page's own files, sorted, under `pages/<id>/`. */
  files: string[];
  /** What the page inherits. */
  inherits: PageInheritsView;
  /** The agents the page attaches. */
  attachments: AttachmentView[];
}

/** What every client shows about a loaded workspace: its layers, files, and what is inherited versus owned. */
export interface WorkspaceManifestView {
  /** The workspace id. */
  id: string;
  /** The workspace name. */
  name: string;
  /** Every page by id, in `workspace.json` order. */
  pages: Record<string, PageManifestView>;
}

function parse<T>(tree: WorkspaceTree, path: string, schema: { parse(value: unknown): T }): T {
  const raw = tree[path];
  return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
}

function hasFolder(paths: readonly string[], dir: string): boolean {
  return paths.some((path) => path.startsWith(`${dir}/`));
}

function baseFolder(tree: WorkspaceTree, paths: readonly string[]): string | undefined {
  const dir = normalizeDir(parse(tree, 'workspace.json', workspaceManifestSchema).harness ?? 'harness');
  return hasFolder(paths, dir) ? dir : undefined;
}

function sharedFolders(paths: readonly string[]): string[] {
  return SHARED_FOLDERS.map((name) => `shared/${name}`).filter((dir) => hasFolder(paths, dir));
}

function attachmentsOf(tree: WorkspaceTree, page: PageManifest, id: string): AttachmentView[] {
  const path = joinPath(`pages/${id}`, page.agents ?? 'agents.json');
  if (!(path in tree)) return [];
  return parse(tree, path, attachmentsSchema).agents.map(({ as, ref }) => ({ alias: as, ref, kind: ref.slice(0, ref.indexOf(':')) as AttachmentView['kind'] }));
}

function pageView(tree: WorkspaceTree, paths: readonly string[], id: string): PageManifestView {
  const page = parse(tree, `pages/${id}/page.json`, pageSchema);
  const base = baseFolder(tree, paths);
  return {
    files: paths.filter((path) => path.startsWith(`pages/${id}/`)),
    inherits: { ...(base !== undefined && { base }), shared: sharedFolders(paths), profiles: [...page.harness.extends] },
    attachments: attachmentsOf(tree, page, id),
  };
}

export function buildManifestView(tree: WorkspaceTree): WorkspaceManifestView {
  const manifest = parse(tree, 'workspace.json', workspaceManifestSchema);
  const paths = Object.keys(tree).sort();
  const pages = Object.fromEntries(manifest.pages.map((id) => [id, pageView(tree, paths, id)]));
  return { id: manifest.id, name: manifest.name, pages };
}
