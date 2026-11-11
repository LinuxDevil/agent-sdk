import { parseAgentRef } from '../contracts/agentRefs';
import type { WorkspaceTree } from '../contracts/baseHarness';
import { normalizeDir } from '../contracts/validateModel';

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
  /** The workspace folders every page inherits that exist in the tree, such as the base harness folder and `shared`. */
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

type Doc = Record<string, unknown>;

function doc(tree: WorkspaceTree, path: string): Doc {
  const raw = tree[path];
  if (raw === undefined) return {};
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sharedFolders(tree: WorkspaceTree, paths: readonly string[]): string[] {
  const harness = doc(tree, 'workspace.json').harness;
  const base = typeof harness === 'string' ? normalizeDir(harness) : 'harness';
  return [base, 'shared'].filter((dir) => paths.some((path) => path.startsWith(`${dir}/`)));
}

function attachmentsOf(tree: WorkspaceTree, id: string): AttachmentView[] {
  const entries = doc(tree, `pages/${id}/agents.json`).agents;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: Doc) => {
    const parsed = typeof entry.ref === 'string' ? parseAgentRef(entry.ref) : undefined;
    return parsed?.ok === true ? [{ alias: String(entry.as), ref: String(entry.ref), kind: parsed.ref.kind }] : [];
  });
}

function profilesOf(tree: WorkspaceTree, id: string): string[] {
  const harness = doc(tree, `pages/${id}/page.json`).harness;
  return typeof harness === 'object' && harness !== null ? strings((harness as Doc).extends) : [];
}

function pageView(tree: WorkspaceTree, paths: readonly string[], shared: string[], id: string): PageManifestView {
  return {
    files: paths.filter((path) => path.startsWith(`pages/${id}/`)),
    inherits: { shared, profiles: profilesOf(tree, id) },
    attachments: attachmentsOf(tree, id),
  };
}

export function buildManifestView(tree: WorkspaceTree): WorkspaceManifestView {
  const manifest = doc(tree, 'workspace.json');
  const paths = Object.keys(tree).sort();
  const shared = sharedFolders(tree, paths);
  const pages = Object.fromEntries(strings(manifest.pages).map((id) => [id, pageView(tree, paths, shared, id)]));
  return { id: String(manifest.id), name: String(manifest.name), pages };
}
