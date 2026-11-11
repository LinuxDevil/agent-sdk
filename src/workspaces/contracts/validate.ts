import { readBaseHarness, type WorkspaceTree } from './baseHarness';
import { forbiddenKeyErrors, type ForbiddenKeyRule } from './forbiddenKeys';
import { harnessProfileSchema } from './harness';
import { crossCheckMainHarness, mainHarnessSchema, type MainHarness } from './mainHarness';
import { workspacePolicySchema } from './policy';
import { SHARED_POLICY_FILE } from './shared';
import { workspaceManifestSchema, type WorkspaceManifest } from './workspace';
import { pageProblems } from './validatePages';
import { dotted, folderOf, harnessCode, joinPath, normalizeDir, problem, readDoc, type Ctx, type Files, type ValidateWorkspaceOptions, type WorkspaceProblem } from './validateModel';

export type { ValidateWorkspaceOptions, WorkspaceProblem, WorkspaceProblemCode, WorkspaceProblemSeverity } from './validateModel';

const POLICY_DIR = 'shared/policies';
const POLICY_KEYS = ['permissions', 'tools', 'secrets', 'network', 'approvals', 'sandbox'];
const POLICY_RULE: ForbiddenKeyRule = { keys: POLICY_KEYS, message: (at, key) => `${at}: declares policy key '${key}'; policy lives only in ${SHARED_POLICY_FILE} (R13, G6)` };

function parseFile(path: string, value: unknown): { value?: unknown; broken: boolean } {
  if (!path.endsWith('.json') || typeof value !== 'string') return { value, broken: false };
  try {
    return { value: JSON.parse(value) as unknown, broken: false };
  } catch {
    return { broken: true };
  }
}

function parseJsonFiles(tree: WorkspaceTree): Files & { problems: WorkspaceProblem[] } {
  const parsed: Record<string, unknown> = {};
  const broken = new Set<string>();
  for (const [path, raw] of Object.entries(tree)) {
    const file = parseFile(path, raw);
    if (file.broken) broken.add(path);
    parsed[path] = file.broken ? raw : file.value;
  }
  return { tree: parsed, broken, read: new Set(), problems: [...broken].map((path) => problem('PRD028', path, '', 'is not valid JSON')) };
}

function readManifest(files: Files): { manifest?: WorkspaceManifest; problems: WorkspaceProblem[] } {
  if (files.broken.has('workspace.json')) return { problems: [] };
  if (!('workspace.json' in files.tree)) return { problems: [problem('PRD023', 'workspace.json', '', 'is missing; every workspace needs a workspace.json')] };
  const read = readDoc(files, 'workspace.json', workspaceManifestSchema, () => 'PRD023');
  return { manifest: read.data, problems: read.problems };
}

const AGENT_FILE = /^[^/]+\/agent\.json$/;
const PAGE_AGENT_FILE = /^pages\/([^/]+)\/agents\/[^/]+\/agent\.json$/;

function isAgentFile(manifest: WorkspaceManifest | undefined, path: string): boolean {
  if (path === 'main-agent/agent.json') return manifest?.mainAgent !== null;
  const page = PAGE_AGENT_FILE.exec(path)?.[1];
  if (page !== undefined) return manifest === undefined || manifest.pages.includes(page);
  const agents = `${normalizeDir(manifest?.agents ?? 'agents')}/`;
  return path.startsWith(agents) && AGENT_FILE.test(path.slice(agents.length));
}

function isScanned(files: Files, path: string, manifest: WorkspaceManifest | undefined): boolean {
  const value = files.tree[path];
  return !files.read.has(path) && !isAgentFile(manifest, path) && !files.broken.has(path) && typeof value === 'object' && value !== null;
}

function policyOutside(files: Files, path: string, manifest: WorkspaceManifest | undefined): WorkspaceProblem[] {
  if (path.startsWith(`${POLICY_DIR}/`)) return [problem('PRD014', path, '', `only ${SHARED_POLICY_FILE} may sit in ${POLICY_DIR}/; policy lives there and nowhere else (R13, G6)`)];
  if (!isScanned(files, path, manifest)) return [];
  return forbiddenKeyErrors(files.tree[path], [POLICY_RULE], path).map((error) => problem('PRD014', path, dotted(error.path), error.message));
}

function policyLocationProblems(files: Files, manifest: WorkspaceManifest | undefined): WorkspaceProblem[] {
  return Object.keys(files.tree)
    .filter((path) => path !== SHARED_POLICY_FILE)
    .flatMap((path) => policyOutside(files, path, manifest));
}

function policyFileProblems(files: Files): WorkspaceProblem[] {
  return readDoc(files, SHARED_POLICY_FILE, workspacePolicySchema, () => 'PRD026').problems.map((item) => ({ ...item, message: `${item.message}; the workspace policy is invalid (R13, G6)` }));
}

interface Folder {
  field: string;
  dir: string;
  explicit: boolean;
}

function folderEntry(field: string, value: string | undefined, fallback: string): Folder {
  return { field, dir: normalizeDir(value ?? fallback), explicit: value !== undefined };
}

function foldersOf(manifest: WorkspaceManifest): Folder[] {
  const folders = [
    folderEntry('harness', manifest.harness, 'harness'),
    folderEntry('agents', manifest.agents, 'agents'),
    folderEntry('harnessProfiles', manifest.harnessProfiles, 'harness-profiles'),
    folderEntry('workflows', manifest.workflows, 'workflows'),
  ];
  return manifest.mainAgent ? [...folders, folderEntry('mainAgent.harness', manifest.mainAgent.harness, 'main-agent/harness')] : folders;
}

function overlaps(a: string, b: string): boolean {
  if (a === '' || a === '.' || b === '' || b === '.') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function reservedProblem(folder: Folder): WorkspaceProblem[] {
  const reserved = [POLICY_DIR, 'pages'].find((dir) => overlaps(folder.dir, dir));
  if (!folder.explicit || reserved === undefined) return [];
  return [problem('PRD027', 'workspace.json', folder.field, `'${folder.dir}' overlaps ${reserved}/; a workspace folder may not point into ${reserved}/${reserved === POLICY_DIR ? ' (R13, G6)' : ''}`)];
}

function pairProblem(earlier: Folder, later: Folder): WorkspaceProblem[] {
  const blamed = later.explicit ? later : earlier;
  const other = blamed === later ? earlier : later;
  if (!blamed.explicit || !overlaps(earlier.dir, later.dir)) return [];
  return [problem('PRD027', 'workspace.json', blamed.field, `'${blamed.dir}' overlaps the ${other.field} folder '${other.dir}'; workspace folders must be separate`)];
}

function folderProblems(manifest: WorkspaceManifest): WorkspaceProblem[] {
  const folders = foldersOf(manifest);
  const pairs = folders.flatMap((later, index) => folders.slice(0, index).flatMap((earlier) => pairProblem(earlier, later)));
  return [...folders.flatMap(reservedProblem), ...pairs];
}

function pageFolders(ctx: Ctx): string[] {
  return [...new Set(Object.keys(ctx.tree).flatMap((path) => /^pages\/([^/]+)\/./.exec(path)?.[1] ?? []))];
}

function pageListingProblems(ctx: Ctx): WorkspaceProblem[] {
  const listed = ctx.manifest.pages;
  const folders = pageFolders(ctx);
  const unlisted = folders
    .filter((folder) => !listed.includes(folder))
    .map((folder) => problem('PRD021', `pages/${folder}/page.json` in ctx.tree ? `pages/${folder}/page.json` : `pages/${folder}`, '', `page folder '${folder}' is not listed in workspace.json pages`));
  const missing = listed.flatMap((id, index) => {
    if (`pages/${id}/page.json` in ctx.tree) return [];
    const reason = folders.includes(id) ? `pages/${id} has no page.json` : `pages/${id} has no folder`;
    return [problem('PRD022', 'workspace.json', `pages.${index}`, `page '${id}' is listed in workspace.json but ${reason}`)];
  });
  return [...unlisted, ...missing];
}

function baseHarnessProblems(ctx: Ctx): WorkspaceProblem[] {
  ctx.read.add(`${normalizeDir(ctx.manifest.harness ?? 'harness')}/harness.json`);
  return readBaseHarness(ctx.tree)
    .problems.filter((item) => !ctx.broken.has(item.path))
    .map((item) => problem(harnessCode(item.message, 'PRD004'), item.path, '', item.message));
}

function profileFileProblems(ctx: Ctx): WorkspaceProblem[] {
  const dir = folderOf(ctx, 'harnessProfiles');
  return Object.keys(ctx.tree)
    .filter((path) => path.startsWith(`${dir}/`) && path.endsWith('/harness.json'))
    .flatMap((path) => readDoc(ctx, path, harnessProfileSchema, (issue) => harnessCode(issue.message, 'PRD003')).problems);
}

function mainHarnessDir(ctx: Ctx): string {
  return normalizeDir(ctx.manifest.mainAgent?.harness ?? 'main-agent/harness');
}

function strayMainProblems(ctx: Ctx): WorkspaceProblem[] {
  if (ctx.manifest.mainAgent !== null) return [];
  return Object.keys(ctx.tree)
    .filter((path) => path.startsWith('main-agent/'))
    .map((path) => problem('PRD011', path, '', 'exists but workspace.json sets mainAgent to null; remove it or set a main agent'));
}

function crossProblems(ctx: Ctx, file: string, harness: MainHarness): WorkspaceProblem[] {
  const { errors, warnings } = crossCheckMainHarness(harness, ctx.manifest);
  return [...errors.map((message) => problem('PRD011', file, '', message)), ...warnings.map((message) => problem('PRD031', file, 'limits.maxConcurrentPages', message, 'warning'))];
}

function routeProblems(ctx: Ctx, file: string, harness: MainHarness): WorkspaceProblem[] {
  return (harness.routes ?? []).flatMap((route, index) =>
    ctx.manifest.pages.includes(route.page) ? [] : [problem('PRD015', file, `routes.${index}.page`, `route names page '${route.page}', which workspace.json does not list`)]
  );
}

function mainProseProblems(ctx: Ctx, dir: string, harness: MainHarness): WorkspaceProblem[] {
  return (harness.instructions ?? []).flatMap((file) => {
    const path = joinPath(dir, file);
    return typeof ctx.tree[path] === 'string' ? [] : [problem('PRD011', path, '', `is listed in the main harness instructions but missing from the workspace`)];
  });
}

function mainAgentProblems(ctx: Ctx): WorkspaceProblem[] {
  const dir = mainHarnessDir(ctx);
  const file = `${dir}/main-harness.json`;
  const read = readDoc(ctx, file, mainHarnessSchema, (issue) => harnessCode(issue.message, 'PRD011'));
  const checks = read.data ? [...crossProblems(ctx, file, read.data), ...routeProblems(ctx, file, read.data), ...mainProseProblems(ctx, dir, read.data)] : [];
  return [...strayMainProblems(ctx), ...read.problems, ...checks];
}

const WORKSPACE_CHECKS: readonly ((ctx: Ctx) => WorkspaceProblem[])[] = [pageListingProblems, baseHarnessProblems, profileFileProblems, mainAgentProblems, pageProblems];

function modeProblems(options: ValidateWorkspaceOptions): WorkspaceProblem[] {
  if (options.mode !== 'strict') return [];
  return [problem('PRD029', 'workspace.lock.json', '', 'strict mode: v1 has no workspace lock (P0.9 is Later), so no lock or pin checks ran', 'info')];
}

function unique(problems: readonly WorkspaceProblem[]): WorkspaceProblem[] {
  const seen = new Set<string>();
  return problems.filter((item) => {
    const key = JSON.stringify([item.severity, item.code, item.file, item.path, item.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function treeProblems(files: Files, options: ValidateWorkspaceOptions): { manifest?: WorkspaceManifest; problems: WorkspaceProblem[] } {
  const { manifest, problems } = readManifest(files);
  if (!manifest) return { problems };
  const folders = folderProblems(manifest);
  if (folders.length > 0) return { manifest, problems: folders };
  const ctx: Ctx = { ...files, options, manifest };
  return { manifest, problems: WORKSPACE_CHECKS.flatMap((check) => check(ctx)) };
}

/** Validates a whole workspace tree across files without touching the file system; never throws for invalid input, and returns every problem in a stable order with a stable code, file and field path. */
export function validateWorkspace(tree: WorkspaceTree, options: ValidateWorkspaceOptions = {}): WorkspaceProblem[] {
  const files = parseJsonFiles(tree);
  const policy = policyFileProblems(files);
  const checked = treeProblems(files, options);
  const problems = [...files.problems, ...policyLocationProblems(files, checked.manifest), ...policy, ...checked.problems, ...modeProblems(options)];
  return unique(problems);
}
