import { issueMessage } from '../../utils/zodCompat';
import { parseAgentRef, type Attachments } from './agentRefs';
import type { WorkspaceTree } from './baseHarness';
import type { Harness } from './harness';
import type { PageManifest } from './page';
import type { PageUi } from './ui';
import type { WorkspaceManifest } from './workspace';

/** How much a problem matters: an `error` makes the workspace invalid, a `warning` is corrected or tolerated, `info` is a note. */
export type WorkspaceProblemSeverity = 'error' | 'warning' | 'info';

/** Stable codes of `validateWorkspace`: PRD001 R13 key in a harness, PRD002 R18 key in a harness, PRD003 harness or profile invalid, PRD004 base harness invalid, PRD005 R13 key in an attachment, PRD006 agents.json invalid, PRD007 bad agent ref, PRD008 page.json invalid, PRD009 nested pages, PRD010 page UI invalid, PRD011 main harness invalid or leftover, PRD012 UI binding, PRD013 harness does not compose, PRD014 policy outside shared/policies, PRD015 route to a missing page, PRD016 goal check names a missing criterion, PRD017 no executable criterion (R19), PRD018 execution alias missing, PRD019 workflow alias missing, PRD020 agent ref has no folder, PRD021 page folder not listed, PRD022 listed page missing, PRD023 workspace.json missing or invalid, PRD024 extends profile not found, PRD025 capability not covered, PRD026 policy file invalid, PRD027 workspace folder overlaps, PRD028 invalid JSON, PRD029 no lock in v1 (strict), PRD030 workflow or goal file missing or invalid, PRD031 main harness limit clamped, PRD032 listed file missing. */
export type WorkspaceProblemCode =
  | 'PRD001'
  | 'PRD002'
  | 'PRD003'
  | 'PRD004'
  | 'PRD005'
  | 'PRD006'
  | 'PRD007'
  | 'PRD008'
  | 'PRD009'
  | 'PRD010'
  | 'PRD011'
  | 'PRD012'
  | 'PRD013'
  | 'PRD014'
  | 'PRD015'
  | 'PRD016'
  | 'PRD017'
  | 'PRD018'
  | 'PRD019'
  | 'PRD020'
  | 'PRD021'
  | 'PRD022'
  | 'PRD023'
  | 'PRD024'
  | 'PRD025'
  | 'PRD026'
  | 'PRD027'
  | 'PRD028'
  | 'PRD029'
  | 'PRD030'
  | 'PRD031'
  | 'PRD032';

/** One problem `validateWorkspace` found, linkable to a file and a field. */
export interface WorkspaceProblem {
  /** How much it matters; only `error` makes the workspace invalid. */
  severity: WorkspaceProblemSeverity;
  /** Stable code, `PRD001` to `PRD032`. */
  code: WorkspaceProblemCode;
  /** The file, relative to the workspace root, or the `global:` ref of a resolved global profile. */
  file: string;
  /** Dotted field path inside `file`, or `''` for the whole file. */
  path: string;
  /** What is wrong, for people. */
  message: string;
}

/** Options for `validateWorkspace`. */
export interface ValidateWorkspaceOptions {
  /** `strict` adds publish-time checks; in v1 it only notes that there is no lock yet (P0.9 is Later). Default `default`. */
  mode?: 'default' | 'strict';
  /** Answers a `global:` harness profile or agent ref with that folder's files, keyed relative to the folder; `undefined` when the host has no such ref. */
  resolveGlobal?: (ref: string) => WorkspaceTree | undefined;
}

export interface Files {
  tree: Readonly<Record<string, unknown>>;
  broken: ReadonlySet<string>;
  read: Set<string>;
}

export interface Ctx extends Files {
  options: ValidateWorkspaceOptions;
  manifest: WorkspaceManifest;
}

export interface Issue {
  path: PropertyKey[];
  message: string;
}

interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Issue[] } };
}

export interface Read<T> {
  data?: T;
  problems: WorkspaceProblem[];
}

export function readDoc<T>(files: Files, file: string, schema: SafeParser<T>, codeOf: (issue: Issue) => WorkspaceProblemCode, scansPolicyKeys = true): Read<T> {
  if (!(file in files.tree) || files.broken.has(file)) return { problems: [] };
  if (scansPolicyKeys) files.read.add(file);
  const result = schema.safeParse(files.tree[file]);
  return result.success ? { data: result.data, problems: [] } : { problems: fromIssues(file, result.error.issues, codeOf) };
}

export function problem(code: WorkspaceProblemCode, file: string, path: string, message: string, severity: WorkspaceProblemSeverity = 'error'): WorkspaceProblem {
  return { severity, code, file, path, message };
}

export function dotted(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

export function fromIssues(file: string, issues: readonly Issue[], codeOf: (issue: Issue) => WorkspaceProblemCode): WorkspaceProblem[] {
  return issues.map((issue) => problem(codeOf(issue), file, dotted(issue.path), issueMessage(issue)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addSegment(segments: string[], segment: string): string[] {
  if (segment === '' || segment === '.') return segments;
  if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') return segments.slice(0, -1);
  return [...segments, segment];
}

export function normalizeDir(dir: string): string {
  return dir.split('/').reduce(addSegment, []).join('/');
}

export function joinPath(dir: string, path: string): string {
  const rest = normalizeDir(path);
  return dir === '' ? rest : `${dir}/${rest}`;
}

export function subtree(tree: Readonly<Record<string, unknown>>, dir: string): Record<string, unknown> {
  const prefix = `${dir}/`;
  return Object.fromEntries(Object.entries(tree).flatMap(([path, value]) => (path.startsWith(prefix) ? [[path.slice(prefix.length), value]] : [])));
}

export function harnessCode(message: string, fallback: WorkspaceProblemCode): WorkspaceProblemCode {
  if (message.endsWith('(R13)')) return 'PRD001';
  if (message.endsWith('(R18)')) return 'PRD002';
  return fallback;
}

export function folderOf(ctx: Ctx, field: 'agents' | 'harnessProfiles' | 'workflows'): string {
  const fallback = { agents: 'agents', harnessProfiles: 'harness-profiles', workflows: 'workflows' }[field];
  return normalizeDir(ctx.manifest[field] ?? fallback);
}

export interface PageView {
  id: string;
  dir: string;
  pagePath: string;
  page?: PageManifest;
  agentsPath: string;
  attachments?: Attachments;
  harnessPath: string;
  harness?: Harness;
  uiPath: string;
  ui?: PageUi;
}

export function goalCriteria(doc: unknown): string[] | undefined {
  if (!isRecord(doc) || !Array.isArray(doc.checks)) return undefined;
  const ids = doc.checks.map((check) => (isRecord(check) ? check.criterion : undefined));
  return ids.every((id): id is string => typeof id === 'string') ? ids : undefined;
}

export function agentFolder(ctx: Ctx, view: PageView, ref: string): string | undefined {
  const parsed = parseAgentRef(ref);
  if (!parsed.ok || parsed.ref.kind === 'global') return undefined;
  return parsed.ref.kind === 'workspace' ? `${folderOf(ctx, 'agents')}/${parsed.ref.name}` : `${view.dir}/agents/${parsed.ref.name}`;
}

export function resolveGlobal(ctx: Ctx, ref: string): { files?: WorkspaceTree; error?: string } {
  try {
    return { files: ctx.options.resolveGlobal?.(ref) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function schemaFiles(harness: Pick<Harness, 'inputs' | 'outputs'>): [string, string][] {
  const inputs = harness.inputs?.schema;
  const outputs = harness.outputs?.schema;
  return [...(typeof inputs === 'string' ? [['inputs.schema', inputs] as [string, string]] : []), ...(typeof outputs === 'string' ? [['outputs.schema', outputs] as [string, string]] : [])];
}

export function missingFile(view: PageView, field: string, path: string): WorkspaceProblem {
  return problem('PRD032', path, '', `is listed in ${view.harnessPath} ${field} but missing from the workspace`);
}
