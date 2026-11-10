import { useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { CircleAlert, Copy, Download, FileText, Folder } from 'lucide-react';
import { stringify as stringifyYaml } from 'yaml';
// `lousho/spec` is the SDK's browser-safe spec entry (S23): `specToCode`
// (S18) and `specToAgentDir` (S19) are both pure renderers, so the Code tab
// generates every view in the browser with no server round-trip.
import { specToAgentDir, specToCode, type AgentSpecV2 } from 'lousho/spec';

import { errorMessage } from '../../../components/errorMessage';
import { downloadText } from '../../../persistence/importExport';
import { useQueryState } from '../../../router/useRoute';
import { Card } from '../../../ui/Card';
import { EmptyState } from '../../../ui/EmptyState';
import { useToast } from '../../../ui/Toast';
import { useAgentDetail } from '../AgentDetailContext';
import { buildTree, CODE_VIEW_LABELS, downloadName, parseCodeView, type CodeView, type TreeNode } from './codeViews';
import '../../../ui/filterBar.css';
import './code.css';

/** One file of the generated agent directory (the element type of `specToAgentDir`'s `files`). */
type DirFile = { path: string; content: string };

/** What one view's generation produced: text (ts/yaml), a file list (dir), or the generator's error. */
type Generated = { kind: 'text'; text: string } | { kind: 'files'; files: DirFile[] } | { kind: 'error'; message: string };

/** The default selected file of the directory view: `agent.yaml` when present, else the first file. */
function defaultFile(files: DirFile[]): string {
  return files.some((f) => f.path === 'agent.yaml') ? 'agent.yaml' : (files[0]?.path ?? '');
}

/** Runs one view's generator on `spec`; a throw becomes the error state for that view only. */
function generateView(view: CodeView, spec: AgentSpecV2): Generated {
  try {
    if (view === 'dir') return { kind: 'files', files: specToAgentDir(spec).files };
    return { kind: 'text', text: view === 'yaml' ? stringifyYaml(spec) : specToCode(spec) };
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) };
  }
}

/** The selected file's path: `?file=` when it names a generated file, else the default. */
function selectedPathOf(file: string | null, files: DirFile[]): string {
  return file !== null && files.some((f) => f.path === file) ? file : defaultFile(files);
}

/** Line-numbered read-only code: numbers come from the `.code-line::before` CSS counter, so Copy selects only code. */
function CodeBlock({ text, label, file = false }: { text: string; label: string; file?: boolean }): JSX.Element {
  return (
    <pre className={file ? 'code-view code-view-file' : 'code-view'} tabIndex={0} aria-label={label}>
      <code>
        {text.split('\n').map((line, index) => (
          <span key={index} className="code-line">
            {line === '' ? ' ' : line}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** One visible row of the tree after collapsed directories are folded away. */
interface TreeRow {
  node: TreeNode;
  parentPath: string | null;
}

function flattenTree(nodes: TreeNode[], collapsed: ReadonlySet<string>, parentPath: string | null, out: TreeRow[]): TreeRow[] {
  for (const node of nodes) {
    out.push({ node, parentPath });
    if (node.kind === 'dir' && !collapsed.has(node.path)) flattenTree(node.children ?? [], collapsed, node.path, out);
  }
  return out;
}

interface FileTreeProps {
  /** The directory's root nodes (`buildTree` output). */
  nodes: TreeNode[];
  /** The selected file's path (`?file=` or the default). */
  selectedPath: string;
  /** Picks a file, writing `?file=<path>`. */
  onSelect(path: string): void;
}

/**
 * The agent-directory tree (A08): a single-select WAI tree with roving
 * tabindex - only the active item takes `tabindex={0}` - arrow keys walk the
 * visible rows, ArrowRight/ArrowLeft open/close directories, Enter/Space
 * selects a file. Directories start expanded; `collapsed` tracks the few
 * the user closes.
 */
function FileTree({ nodes, selectedPath, onSelect }: FileTreeProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const rows = useMemo(() => flattenTree(nodes, collapsed, null, []), [nodes, collapsed]);
  const active = activePath !== null && rows.some((row) => row.node.path === activePath) ? activePath : rows[0]?.node.path;

  const setOpen = (path: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });

  const focusRow = (row: TreeRow | undefined) => {
    if (row === undefined) return;
    setActivePath(row.node.path);
    buttons.current.get(row.node.path)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const path = (event.target as HTMLElement).closest('[data-path]')?.getAttribute('data-path');
    const index = rows.findIndex((row) => row.node.path === path);
    if (path === null || path === undefined || index < 0) return;
    const row = rows[index];
    const parent = rows.find((r) => r.node.path === row.parentPath);
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]);
        break;
      case 'ArrowUp':
        focusRow(rows[index - 1]);
        break;
      case 'ArrowRight':
        if (row.node.kind !== 'dir') return;
        if (collapsed.has(path)) setOpen(path, true);
        else focusRow(rows[index + 1]);
        break;
      case 'ArrowLeft':
        if (row.node.kind === 'dir' && !collapsed.has(path)) setOpen(path, false);
        else focusRow(parent);
        break;
      case 'Home':
        focusRow(rows[0]);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]);
        break;
      case 'Enter':
      case ' ':
        if (row.node.kind === 'file') onSelect(path);
        else setOpen(path, collapsed.has(path));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderNode = (node: TreeNode): ReactNode => {
    const isDir = node.kind === 'dir';
    const open = isDir && !collapsed.has(node.path);
    const Icon = isDir ? Folder : FileText;
    return (
      <li
        key={node.path}
        role="treeitem"
        aria-expanded={isDir ? open : undefined}
        aria-selected={isDir ? undefined : node.path === selectedPath}
      >
        <button
          type="button"
          className="code-tree-item"
          data-path={node.path}
          tabIndex={node.path === active ? 0 : -1}
          ref={(el) => {
            if (el === null) buttons.current.delete(node.path);
            else buttons.current.set(node.path, el);
          }}
          onClick={() => {
            setActivePath(node.path);
            if (isDir) setOpen(node.path, collapsed.has(node.path));
            else onSelect(node.path);
          }}
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          {node.name}
        </button>
        {open && <ul role="group">{(node.children ?? []).map(renderNode)}</ul>}
      </li>
    );
  };

  return (
    <ul className="code-tree" role="tree" aria-label="Files" onKeyDown={onKeyDown}>
      {nodes.map(renderNode)}
    </ul>
  );
}

/** The directory view: the tree beside the selected file's preview. */
function DirView({ files, selectedPath, onSelect }: { files: DirFile[]; selectedPath: string; onSelect(path: string): void }): JSX.Element {
  const tree = useMemo(() => buildTree(files), [files]);
  const selected = files.find((f) => f.path === selectedPath);
  return (
    <div className="code-dir">
      <FileTree nodes={tree} selectedPath={selectedPath} onSelect={onSelect} />
      <CodeBlock file text={selected?.content ?? ''} label={selectedPath} />
    </div>
  );
}

interface ViewBodyProps {
  /** The active view's generation result. */
  generated: Generated;
  /** `label` is the text view's `aria-label` (`"<view> for <agent>"`); the file preview's is its path. */
  label: string;
  selectedPath: string;
  onSelect(path: string): void;
}

/** Below the toolbar: the error card, the directory view, or the line-numbered text view. */
function ViewBody({ generated, label, selectedPath, onSelect }: ViewBodyProps): JSX.Element {
  if (generated.kind === 'error') {
    return (
      <Card>
        <EmptyState icon={CircleAlert} title="Could not generate code" hint={generated.message} />
      </Card>
    );
  }
  if (generated.kind === 'files') return <DirView files={generated.files} selectedPath={selectedPath} onSelect={onSelect} />;
  return <CodeBlock text={generated.text} label={label} />;
}

/**
 * The Code tab (A08, PLAN §11 `/agents/:id/code`): the agent's spec rendered
 * as TypeScript (`specToCode`), as YAML, and as an agent-directory file tree
 * with a file preview (`specToAgentDir`). Every view is read-only - edits
 * happen on the canvas or in Configure; Copy takes the visible text and the
 * TS/YAML views also download. `?view=` and `?file=` hold the state so a
 * reload or a pasted link lands on the same view.
 */
export function CodeTab(): JSX.Element {
  const { record } = useAgentDetail();
  const toast = useToast();
  const [view, setView] = useQueryState<CodeView>('view', parseCodeView, (v) => (v === 'ts' ? null : v));
  const [file, setFile] = useQueryState<string | null>('file', (s) => s, (v) => v);

  // `record.updatedAt` is the spec's change signal: the same timestamp means
  // the same spec, so the generated text can be memoized on it.
  const generated = useMemo(() => generateView(view, record.spec), [view, record.updatedAt]);
  const files = generated.kind === 'files' ? generated.files : [];
  const selectedPath = selectedPathOf(file, files);
  const visibleText = generated.kind === 'text' ? generated.text : (files.find((f) => f.path === selectedPath)?.content ?? '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visibleText);
      toast.show({ message: 'Copied', tone: 'success' });
    } catch {
      toast.show({ message: 'Could not copy', tone: 'error' });
    }
  };

  const download = () => {
    if (view === 'dir' || generated.kind !== 'text') return;
    downloadText(generated.text, downloadName(record.id, view), view === 'yaml' ? 'application/x-yaml' : 'text/plain');
  };

  const name = record.spec.name ?? record.id;

  return (
    <div className="code-tab">
      <div className="code-toolbar">
        <div className="segmented" role="group" aria-label="Code view">
          {(Object.keys(CODE_VIEW_LABELS) as CodeView[]).map((v) => (
            <button key={v} type="button" className="seg-btn" aria-pressed={view === v} onClick={() => setView(v)}>
              {CODE_VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <div className="code-actions">
          <button type="button" className="btn btn-sm" onClick={() => void copy()}>
            <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            Copy
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={view === 'dir'}
            title={view === 'dir' ? 'Copy files one at a time from the tree' : undefined}
            onClick={download}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            Download
          </button>
        </div>
      </div>
      <p className="code-note">Generated from the spec. Read-only — edit on the canvas or in Configure.</p>
      <ViewBody
        generated={generated}
        label={`${CODE_VIEW_LABELS[view]} for ${name}`}
        selectedPath={selectedPath}
        onSelect={setFile}
      />
    </div>
  );
}
