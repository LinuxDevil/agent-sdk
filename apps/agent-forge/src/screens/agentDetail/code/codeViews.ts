/**
 * The Code tab's pure view helpers (A08): which generated view the `?view=`
 * query names, the file tree the agent-directory preview renders, and the
 * download file names. Kept component-free so the tree ordering is testable
 * without jsdom.
 */

/** The Code tab's generated views, in segmented-control order. */
export type CodeView = 'ts' | 'yaml' | 'dir';

/** The segmented control's label per view. */
export const CODE_VIEW_LABELS: Record<CodeView, string> = {
  ts: 'TypeScript',
  yaml: 'YAML',
  dir: 'Agent directory',
};

/** Parses a `?view=` value into a {@link CodeView}; anything unknown is the default `'ts'`. */
export function parseCodeView(s: string | null): CodeView {
  return s === 'yaml' || s === 'dir' ? s : 'ts';
}

/** One node of the agent-directory preview tree. */
export interface TreeNode {
  /** The base name shown in the tree, e.g. 'system.md', 'prompts'. */
  name: string;
  /** The path from the agent directory's root, '/' separators. */
  path: string;
  kind: 'dir' | 'file';
  /** A directory's children (sorted); absent on files. */
  children?: TreeNode[];
}

function insertPath(nodes: TreeNode[], parts: string[], prefix: string): void {
  const [head, ...rest] = parts;
  const path = prefix === '' ? head : `${prefix}/${head}`;
  if (rest.length === 0) {
    nodes.push({ name: head, path, kind: 'file' });
    return;
  }
  let dir = nodes.find((n) => n.kind === 'dir' && n.name === head);
  if (dir === undefined) {
    dir = { name: head, path, kind: 'dir', children: [] };
    nodes.push(dir);
  }
  insertPath(dir.children ?? [], rest, path);
}

/** Folders before files, then alphabetical ignoring case (ties broken by code unit). */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children !== undefined) sortNodes(node.children);
  }
}

/**
 * Groups flat `{ path }` file entries into a sorted tree: folders first, then
 * files, alphabetical and case-insensitive at every level. Directory nodes
 * carry their own `/`-separated path for expand/collapse and focus state.
 */
export function buildTree(files: { path: string }[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter((part) => part !== '');
    if (parts.length > 0) insertPath(root, parts, '');
  }
  sortNodes(root);
  return root;
}

/** The download file name for a text view: `<id>.agent.ts` or `<id>.yaml`. */
export function downloadName(id: string, view: 'ts' | 'yaml'): string {
  return view === 'ts' ? `${id}.agent.ts` : `${id}.yaml`;
}
