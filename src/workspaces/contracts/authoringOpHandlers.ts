import { issuePath, type SafeParser } from '../../utils/zodCompat';
import { attachmentsSchema } from './agentRefs';
import { baseHarnessSchema, readBaseHarness, type WorkspaceTree } from './baseHarness';
import { harnessSchema } from './harness';
import { crossCheckMainHarness, mainHarnessSchema } from './mainHarness';
import { pageSchema } from './page';
import { SHARED_PATH_PATTERNS } from './shared';
import { workspaceManifestSchema } from './workspace';
import { flowProblems, flowSpecSchema } from '../../spec/v2/flow';
import { checkForbiddenKeys } from './forbiddenKeys';
import type { AuthoringOp, AuthoringProblem, AuthoringValidator, ProseTarget } from './authoringOps';

type Doc = Record<string, unknown>;
type Problem = { path: string; message: string };
type Plan = { writes: Record<string, unknown>; deletes?: string[] } | { problems: Problem[] };
type Op<N extends AuthoringOp['op']> = Extract<AuthoringOp, { op: N }>;
interface Entry {
  path: string;
  doc: unknown;
  schema?: SafeParser<unknown>;
}
interface State {
  tree: WorkspaceTree;
  problems: AuthoringProblem[];
  touched: Map<string, number>;
}

const HARNESS_SCHEMA = 'lousho.harness/1';
const isRecord = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value);
const clean = (path: string): string => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const join = (...parts: string[]): string => parts.map(clean).filter((part) => part !== '').join('/');
const fail = (path: string, message: string): Plan => ({ problems: [{ path, message }] });
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function readDoc(tree: WorkspaceTree, path: string): Doc | undefined {
  const raw = tree[path];
  if (typeof raw !== 'string') return isRecord(raw) ? raw : undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function withField(doc: Doc, field: string, value: unknown): Doc {
  const next = { ...doc };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

function build(entries: Entry[], deletes?: string[]): Plan {
  const writes: Record<string, unknown> = {};
  const problems: Problem[] = [];
  for (const { path, doc, schema } of entries) {
    const parsed = schema === undefined ? { success: true as const, data: doc } : schema.safeParse(doc);
    if (parsed.success) writes[path] = parsed.data;
    else problems.push(...parsed.error.issues.map((issue) => ({ path, message: issue.path?.length ? `${issuePath(issue)}: ${issue.message}` : issue.message })));
  }
  return problems.length > 0 ? { problems } : { writes, deletes };
}

const manifestOf = (tree: WorkspaceTree): Doc | undefined => readDoc(tree, 'workspace.json');
const pagesOf = (manifest: Doc): string[] => (Array.isArray(manifest.pages) ? manifest.pages.filter((item): item is string => typeof item === 'string') : []);

function missingManifest(): Plan {
  return fail('workspace.json', 'does not exist; create_workspace comes first');
}

function pageDoc(tree: WorkspaceTree, page: string): Doc | undefined {
  return readDoc(tree, `pages/${page}/page.json`);
}

const missingPage = (page: string): Plan => fail(`pages/${page}/page.json`, `page '${page}' does not exist`);

function pageRel(page: Doc, key: 'agents' | 'ui', fallback: string): string {
  return str(page[key]) ?? fallback;
}

function pageHarnessDir(tree: WorkspaceTree, page: string): string {
  const harness = pageDoc(tree, page)?.harness;
  return join(`pages/${page}`, (isRecord(harness) ? str(harness.overrides) : undefined) ?? 'harness');
}

const agentsDirOf = (tree: WorkspaceTree): string => clean(str(manifestOf(tree)?.agents) ?? 'agents');
const baseDirOf = (tree: WorkspaceTree): string => clean(str(manifestOf(tree)?.harness) ?? 'harness');

function mainDirOf(tree: WorkspaceTree): string | undefined {
  const mainAgent = manifestOf(tree)?.mainAgent;
  if (!isRecord(mainAgent)) return undefined;
  return clean(str(mainAgent.harness) ?? 'main-agent/harness');
}

interface HarnessFile {
  path: string;
  dir: string;
  schema: SafeParser<unknown>;
  owner: string;
  prefix: string;
  empty: Doc;
}

function harnessFile(tree: WorkspaceTree, target: ProseTarget): HarnessFile | Plan {
  if (target.kind === 'base') {
    const dir = baseDirOf(tree);
    return { path: `${dir}/harness.json`, dir, schema: baseHarnessSchema, owner: dir, prefix: '', empty: { schema: HARNESS_SCHEMA } };
  }
  if (target.kind === 'main') {
    const dir = mainDirOf(tree);
    if (dir === undefined) return fail('workspace.json', 'mainAgent is null; the workspace has no main-agent harness');
    return { path: `${dir}/main-harness.json`, dir, schema: mainHarnessSchema, owner: dir, prefix: '', empty: { schema: 'lousho.main-harness/1' } };
  }
  if (pageDoc(tree, target.page) === undefined) return missingPage(target.page);
  const dir = pageHarnessDir(tree, target.page);
  return { path: `${dir}/harness.json`, dir, schema: harnessSchema, owner: `pages/${target.page}`, prefix: dir.slice(`pages/${target.page}/`.length), empty: { schema: HARNESS_SCHEMA } };
}

const isPlan = (value: HarnessFile | Plan): value is Plan => 'problems' in value || 'writes' in value;

function setFieldIn(tree: WorkspaceTree, target: ProseTarget, field: string, value: unknown): Plan {
  const file = harnessFile(tree, target);
  if (isPlan(file)) return file;
  return build([{ path: file.path, doc: withField(readDoc(tree, file.path) ?? file.empty, field, value), schema: file.schema }]);
}

function setDocField(tree: WorkspaceTree, path: string, schema: SafeParser<unknown>, field: string, value: unknown): Plan {
  const doc = readDoc(tree, path);
  return doc === undefined ? fail(path, 'does not exist') : build([{ path, doc: withField(doc, field, value), schema }]);
}

function createWorkspace(op: Op<'create_workspace'>, tree: WorkspaceTree): Plan {
  if ('workspace.json' in tree) return fail('workspace.json', 'already exists');
  const doc = { schema: 'lousho.workspace/1', id: op.id, name: op.name, version: op.version ?? '0.1.0', description: op.description, ...(op.domain !== undefined && { domain: op.domain }), mainAgent: op.mainAgent ?? null, pages: [] };
  return build([{ path: 'workspace.json', doc, schema: workspaceManifestSchema }]);
}

function setWorkspaceField(op: Op<'set_workspace_field'>, tree: WorkspaceTree): Plan {
  return setDocField(tree, 'workspace.json', workspaceManifestSchema, op.field, op.value);
}

function createPage(op: Op<'create_page'>, tree: WorkspaceTree): Plan {
  const manifest = manifestOf(tree);
  if (manifest === undefined) return missingManifest();
  if (pagesOf(manifest).includes(op.page) || pageDoc(tree, op.page) !== undefined) return fail(`pages/${op.page}/page.json`, `page '${op.page}' already exists`);
  const base = `pages/${op.page}`;
  const page = { schema: 'lousho.page/1', id: op.page, name: op.name, description: op.description, ...(op.domain !== undefined && { domain: op.domain }), harness: { extends: [] }, execution: op.execution };
  return build([
    { path: 'workspace.json', doc: { ...manifest, pages: [...pagesOf(manifest), op.page] }, schema: workspaceManifestSchema },
    { path: `${base}/page.json`, doc: page, schema: pageSchema },
    { path: `${base}/harness/harness.json`, doc: { schema: HARNESS_SCHEMA }, schema: harnessSchema },
    { path: `${base}/agents.json`, doc: { schema: 'lousho.agents/1', agents: [] }, schema: attachmentsSchema },
  ]);
}

function removePage(op: Op<'remove_page'>, tree: WorkspaceTree): Plan {
  const manifest = manifestOf(tree);
  if (manifest === undefined) return missingManifest();
  if (!pagesOf(manifest).includes(op.page)) return missingPage(op.page);
  const deletes = Object.keys(tree).filter((path) => path.startsWith(`pages/${op.page}/`));
  const plan = build([{ path: 'workspace.json', doc: { ...manifest, pages: pagesOf(manifest).filter((page) => page !== op.page) }, schema: workspaceManifestSchema }]);
  return 'writes' in plan ? { ...plan, deletes } : plan;
}

function reorderPages(op: Op<'reorder_pages'>, tree: WorkspaceTree): Plan {
  const manifest = manifestOf(tree);
  if (manifest === undefined) return missingManifest();
  const current = pagesOf(manifest);
  const same = op.pages.length === current.length && current.every((page) => op.pages.includes(page));
  if (!same) return fail('workspace.json', `pages must list every existing page exactly once (${current.join(', ')})`);
  return build([{ path: 'workspace.json', doc: { ...manifest, pages: op.pages }, schema: workspaceManifestSchema }]);
}

function setPageField(op: Op<'set_page_field'>, tree: WorkspaceTree): Plan {
  return pageDoc(tree, op.page) === undefined ? missingPage(op.page) : setDocField(tree, `pages/${op.page}/page.json`, pageSchema, op.field, op.value);
}

function setHarnessField(op: Op<'set_harness_field'>, tree: WorkspaceTree): Plan {
  return setFieldIn(tree, { kind: 'page', page: op.page }, op.field, op.value);
}

function setBaseHarnessField(op: Op<'set_base_harness_field'>, tree: WorkspaceTree): Plan {
  return setFieldIn(tree, { kind: 'base' }, op.field, op.value);
}

function setMainHarnessField(op: Op<'set_main_harness_field'>, tree: WorkspaceTree): Plan {
  return setFieldIn(tree, { kind: 'main' }, op.field, op.value);
}

function writeHarnessProse(op: Op<'write_harness_prose'>, tree: WorkspaceTree): Plan {
  const file = harnessFile(tree, op.target);
  if (isPlan(file)) return file;
  const doc = readDoc(tree, file.path) ?? file.empty;
  const entry = join(file.prefix, op.file);
  const listed = Array.isArray(doc.instructions) ? doc.instructions : [];
  const next = listed.includes(entry) ? doc : { ...doc, instructions: [...listed, entry] };
  return build([{ path: file.path, doc: next, schema: file.schema }, { path: `${file.dir}/${op.file}`, doc: op.text }]);
}

function extendsOf(tree: WorkspaceTree, page: string): string[] {
  const harness = pageDoc(tree, page)?.harness;
  const list = isRecord(harness) ? harness.extends : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

function writeExtends(tree: WorkspaceTree, page: string, list: string[]): Plan {
  const doc = pageDoc(tree, page);
  const harness = doc !== undefined && isRecord(doc.harness) ? doc.harness : {};
  return build([{ path: `pages/${page}/page.json`, doc: { ...doc, harness: { ...harness, extends: list } }, schema: pageSchema }]);
}

function addExtends(op: Op<'add_extends'>, tree: WorkspaceTree): Plan {
  if (pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const list = extendsOf(tree, op.page);
  if (list.includes(op.ref)) return fail(`pages/${op.page}/page.json`, `'${op.ref}' is already in extends`);
  const next = [...list];
  next.splice(op.index ?? list.length, 0, op.ref);
  return writeExtends(tree, op.page, next);
}

function removeExtends(op: Op<'remove_extends'>, tree: WorkspaceTree): Plan {
  if (pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const list = extendsOf(tree, op.page);
  if (!list.includes(op.ref)) return fail(`pages/${op.page}/page.json`, `'${op.ref}' is not in extends`);
  return writeExtends(tree, op.page, list.filter((ref) => ref !== op.ref));
}

function criteriaOf(doc: Doc): unknown[] {
  const evaluation = doc.evaluation;
  return isRecord(evaluation) && Array.isArray(evaluation.criteria) ? evaluation.criteria : [];
}

function writeCriteria(tree: WorkspaceTree, target: Op<'add_criterion'>['target'], change: (criteria: unknown[]) => unknown[] | string): Plan {
  const file = harnessFile(tree, target);
  if (isPlan(file)) return file;
  const doc = readDoc(tree, file.path) ?? file.empty;
  const criteria = change(criteriaOf(doc));
  if (typeof criteria === 'string') return fail(file.path, criteria);
  const evaluation = isRecord(doc.evaluation) ? doc.evaluation : {};
  return build([{ path: file.path, doc: { ...doc, evaluation: { ...evaluation, criteria } }, schema: file.schema }]);
}

const hasId = (item: unknown, id: string): boolean => isRecord(item) && item.id === id;

function addCriterion(op: Op<'add_criterion'>, tree: WorkspaceTree): Plan {
  return writeCriteria(tree, op.target, (criteria) => (criteria.some((item) => hasId(item, op.criterion.id)) ? `criterion '${op.criterion.id}' already exists` : [...criteria, op.criterion]));
}

function removeCriterion(op: Op<'remove_criterion'>, tree: WorkspaceTree): Plan {
  return writeCriteria(tree, op.target, (criteria) => (criteria.some((item) => hasId(item, op.id)) ? criteria.filter((item) => !hasId(item, op.id)) : `criterion '${op.id}' does not exist`));
}

function agentDir(tree: WorkspaceTree, name: string, page?: string): string {
  return page === undefined ? `${agentsDirOf(tree)}/${name}` : `pages/${page}/agents/${name}`;
}

function createAgent(op: Op<'create_agent'>, tree: WorkspaceTree): Plan {
  if (op.page !== undefined && pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const dir = agentDir(tree, op.name, op.page);
  if (`${dir}/agent.json` in tree) return fail(`${dir}/agent.json`, `agent '${op.name}' already exists`);
  const spec = { name: op.name, version: op.version ?? '1.0.0', description: op.description, ...(op.model !== undefined && { model: op.model }) };
  return build([{ path: `${dir}/agent.json`, doc: spec }, { path: `${dir}/instructions.md`, doc: op.instructions }]);
}

function writeAgentProse(op: Op<'write_agent_prose'>, tree: WorkspaceTree): Plan {
  const dir = agentDir(tree, op.agent, op.page);
  if (!(`${dir}/agent.json` in tree)) return fail(`${dir}/agent.json`, `agent '${op.agent}' does not exist`);
  return build([{ path: `${dir}/instructions.md`, doc: op.text }]);
}

function agentsFile(tree: WorkspaceTree, page: string): { path: string; doc: Doc } | Plan {
  const doc = pageDoc(tree, page);
  if (doc === undefined) return missingPage(page);
  const path = join(`pages/${page}`, pageRel(doc, 'agents', 'agents.json'));
  return { path, doc: readDoc(tree, path) ?? { schema: 'lousho.agents/1', agents: [] } };
}

const isFile = (value: { path: string; doc: Doc } | Plan): value is { path: string; doc: Doc } => 'path' in value;

function attachmentsOf(doc: Doc): unknown[] {
  return Array.isArray(doc.agents) ? doc.agents : [];
}

function writeAttachments(tree: WorkspaceTree, page: string, change: (agents: unknown[]) => unknown[] | string): Plan {
  const file = agentsFile(tree, page);
  if (!isFile(file)) return file;
  const agents = change(attachmentsOf(file.doc));
  if (typeof agents === 'string') return fail(file.path, agents);
  return build([{ path: file.path, doc: { ...file.doc, agents }, schema: attachmentsSchema }]);
}

const hasAlias = (item: unknown, alias: string): boolean => isRecord(item) && item.as === alias;

function attachAgent(op: Op<'attach_agent'>, tree: WorkspaceTree): Plan {
  return writeAttachments(tree, op.page, (agents) => [...agents, op.attachment]);
}

function detachAgent(op: Op<'detach_agent'>, tree: WorkspaceTree): Plan {
  return writeAttachments(tree, op.page, (agents) => (agents.some((item) => hasAlias(item, op.as)) ? agents.filter((item) => !hasAlias(item, op.as)) : `no attachment with alias '${op.as}'`));
}

function setAttachmentField(op: Op<'set_attachment_field'>, tree: WorkspaceTree): Plan {
  const change = (item: unknown): unknown => (hasAlias(item, op.as) && isRecord(item) ? withField(item, op.field, op.value) : item);
  return writeAttachments(tree, op.page, (agents) => (agents.some((item) => hasAlias(item, op.as)) ? agents.map(change) : `no attachment with alias '${op.as}'`));
}

function setExecution(tree: WorkspaceTree, page: string, change: (execution: Doc) => Doc): Plan {
  const doc = pageDoc(tree, page);
  if (doc === undefined) return missingPage(page);
  const execution = isRecord(doc.execution) ? doc.execution : {};
  return build([{ path: `pages/${page}/page.json`, doc: { ...doc, execution: change(execution) }, schema: pageSchema }]);
}

function setExecutionType(op: Op<'set_execution_type'>, tree: WorkspaceTree): Plan {
  return setExecution(tree, op.page, (execution) => ({ ...execution, type: op.type }));
}

function setExecutionConfig(op: Op<'set_execution_config'>, tree: WorkspaceTree): Plan {
  return setExecution(tree, op.page, (execution) => withField(execution, op.key, op.value));
}

function plainData(value: unknown, root: string): { data: unknown } | Problem[] {
  const { errors, data } = checkForbiddenKeys(value, [], root);
  return errors.length > 0 ? errors.map((error) => ({ path: root, message: error.message })) : { data };
}

function writePageDoc(tree: WorkspaceTree, page: string, rel: string, value: unknown): Plan {
  if (pageDoc(tree, page) === undefined) return missingPage(page);
  const scanned = plainData(value, rel);
  if (Array.isArray(scanned)) return { problems: scanned.map((problem) => ({ path: `pages/${page}/${rel}`, message: problem.message })) };
  if (!isRecord(scanned.data)) return fail(`pages/${page}/${rel}`, 'must be a JSON object');
  return build([{ path: `pages/${page}/${rel}`, doc: scanned.data }]);
}

function aliasesOf(tree: WorkspaceTree, page: string): string[] {
  const file = agentsFile(tree, page);
  return isFile(file) ? attachmentsOf(file.doc).flatMap((item) => (isRecord(item) && typeof item.as === 'string' ? [item.as] : [])) : [];
}

function writeWorkflow(op: Op<'write_workflow'>, tree: WorkspaceTree): Plan {
  const parsed = flowSpecSchema.safeParse(op.workflow);
  if (!parsed.success) return { problems: parsed.error.issues.map((issue) => ({ path: `pages/${op.page}/workflow.json`, message: `${issuePath(issue)}: ${issue.message}` })) };
  const problems = flowProblems(parsed.data, { agentNames: aliasesOf(tree, op.page) });
  if (problems.length > 0) return { problems: problems.map((problem) => ({ path: `pages/${op.page}/workflow.json`, message: `${problem.path.join('.')}: ${problem.message}` })) };
  return writePageDoc(tree, op.page, 'workflow.json', parsed.data);
}

function writeGoal(op: Op<'write_goal'>, tree: WorkspaceTree): Plan {
  const goal = isRecord(op.goal) ? op.goal : {};
  if (goal.schema !== 'lousho.goal/1') return fail(`pages/${op.page}/goal.json`, "schema: must be 'lousho.goal/1'");
  return writePageDoc(tree, op.page, 'goal.json', op.goal);
}

function uiRel(tree: WorkspaceTree, page: string): string {
  const doc = pageDoc(tree, page);
  return clean(doc === undefined ? 'ui/page.ui.json' : pageRel(doc, 'ui', 'ui/page.ui.json'));
}

function writePageUi(op: Op<'write_page_ui'>, tree: WorkspaceTree): Plan {
  return writePageDoc(tree, op.page, uiRel(tree, op.page), op.ui);
}

function resetPageUi(op: Op<'reset_page_ui'>, tree: WorkspaceTree): Plan {
  if (pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const path = `pages/${op.page}/${uiRel(tree, op.page)}`;
  return path in tree ? { writes: {}, deletes: [path] } : fail(path, 'does not exist; the default UI already applies');
}

function writeSharedInstruction(op: Op<'write_shared_instruction'>): Plan {
  const path = `shared/instructions/${op.file}`;
  return SHARED_PATH_PATTERNS.instructions.test(path) ? build([{ path, doc: op.text }]) : fail(path, 'must be shared/instructions/<name>.md');
}

type Handlers = { [N in AuthoringOp['op']]: (op: Op<N>, tree: WorkspaceTree) => Plan };

const HANDLERS: Handlers = {
  create_workspace: createWorkspace,
  set_workspace_field: setWorkspaceField,
  create_page: createPage,
  remove_page: removePage,
  reorder_pages: reorderPages,
  set_page_field: setPageField,
  set_harness_field: setHarnessField,
  write_harness_prose: writeHarnessProse,
  add_extends: addExtends,
  remove_extends: removeExtends,
  set_base_harness_field: setBaseHarnessField,
  set_main_harness_field: setMainHarnessField,
  add_criterion: addCriterion,
  remove_criterion: removeCriterion,
  create_agent: createAgent,
  write_agent_prose: writeAgentProse,
  attach_agent: attachAgent,
  detach_agent: detachAgent,
  set_attachment_field: setAttachmentField,
  set_execution_type: setExecutionType,
  set_execution_config: setExecutionConfig,
  write_workflow: writeWorkflow,
  write_goal: writeGoal,
  write_page_ui: writePageUi,
  reset_page_ui: resetPageUi,
  write_shared_instruction: writeSharedInstruction,
};

export function planOp(op: AuthoringOp, tree: WorkspaceTree): Plan {
  return (HANDLERS[op.op] as (op: AuthoringOp, tree: WorkspaceTree) => Plan)(op, tree);
}

export function applyOp(state: State, op: AuthoringOp, opIndex: number): State {
  const plan = planOp(op, state.tree);
  if ('problems' in plan) return { ...state, problems: plan.problems.map((problem) => ({ opIndex, op: op.op, ...problem })) };
  const tree: Record<string, unknown> = { ...state.tree, ...plan.writes };
  const touched = new Map(state.touched);
  for (const path of plan.deletes ?? []) delete tree[path];
  for (const path of [...Object.keys(plan.writes), ...(plan.deletes ?? [])]) touched.set(path, opIndex);
  return { tree, problems: [], touched };
}

function pageListProblems(tree: WorkspaceTree, manifest: Doc): Problem[] {
  const listed = pagesOf(manifest);
  const folders = Object.keys(tree).flatMap((path) => /^pages\/([^/]+)\/page\.json$/.exec(path)?.[1] ?? []);
  return [
    ...listed.filter((page) => !folders.includes(page)).map((page) => ({ path: 'workspace.json', message: `pages lists '${page}' but pages/${page}/page.json is missing` })),
    ...folders.filter((page) => !listed.includes(page)).map((page) => ({ path: `pages/${page}/page.json`, message: `page '${page}' is not listed in workspace.json pages` })),
  ];
}

function missingProse(tree: WorkspaceTree, file: HarnessFile, doc: Doc): Problem[] {
  const listed = Array.isArray(doc.instructions) ? doc.instructions.filter((item): item is string => typeof item === 'string') : [];
  return listed.flatMap((entry) => {
    const path = join(file.owner, entry);
    return typeof tree[path] === 'string' ? [] : [{ path, message: 'is listed in instructions but missing from the workspace' }];
  });
}

function pageProblems(tree: WorkspaceTree, page: string): Problem[] {
  const file = harnessFile(tree, { kind: 'page', page });
  const doc = isPlan(file) ? undefined : readDoc(tree, file.path);
  const prose = !isPlan(file) && doc !== undefined ? missingProse(tree, file, doc) : [];
  return prose;
}

function mainProblems(tree: WorkspaceTree, manifest: Doc): Problem[] {
  const dir = mainDirOf(tree);
  const path = `${dir}/main-harness.json`;
  const doc = dir === undefined ? undefined : readDoc(tree, path);
  const parsedManifest = workspaceManifestSchema.safeParse(manifest);
  const parsed = mainHarnessSchema.safeParse(doc);
  if (doc === undefined || !parsed.success || !parsedManifest.success) return [];
  return crossCheckMainHarness(parsed.data, parsedManifest.data).errors.map((message) => ({ path, message }));
}

function builtInProblems(tree: WorkspaceTree): Problem[] {
  const manifest = manifestOf(tree);
  if (manifest === undefined) return [];
  const base = readBaseHarness(tree).problems;
  return [...pageListProblems(tree, manifest), ...pagesOf(manifest).flatMap((page) => pageProblems(tree, page)), ...base, ...mainProblems(tree, manifest)];
}

export function finalProblems(tree: WorkspaceTree, touched: Map<string, number>, ops: readonly AuthoringOp[], validate?: AuthoringValidator): AuthoringProblem[] {
  return [...builtInProblems(tree), ...(validate?.(tree) ?? [])].map((problem) => {
    const opIndex = touched.get(problem.path);
    return opIndex === undefined ? problem : { opIndex, op: ops[opIndex]?.op, ...problem };
  });
}
