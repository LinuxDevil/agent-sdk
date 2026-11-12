import { issuePath, type SafeParser } from '../../utils/zodCompat';
import { attachmentsSchema } from './agentRefs';
import { baseHarnessSchema, type WorkspaceTree } from './baseHarness';
import { harnessSchema } from './harness';
import { mainHarnessSchema } from './mainHarness';
import { pageSchema } from './page';
import { SHARED_PATH_PATTERNS } from './shared';
import { workspaceManifestSchema } from './workspace';
import { flowProblems, flowSpecSchema } from '../../spec/v2/flow';
import { goalSchema } from '../../goals/contract';
import { checkForbiddenKeys, FORBIDDEN_HARNESS_KEYS, type ForbiddenKeyRule } from './forbiddenKeys';
import type { AuthoringOp, AuthoringProblem, AuthoringTreeProblem, AuthoringValidator, ProseTarget } from './authoringOps';

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
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const clean = (path: string): string => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const join = (...parts: string[]): string => parts.map(clean).filter((part) => part !== '').join('/');
const fail = (path: string, message: string): Plan => ({ problems: [{ path, message }] });

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

const MAIN_DIR = 'main-agent/harness';

function mainDirOf(tree: WorkspaceTree): string | undefined {
  return isRecord(manifestOf(tree)?.mainAgent) ? MAIN_DIR : undefined;
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
    const dir = 'harness';
    return { path: `${dir}/harness.json`, dir, schema: baseHarnessSchema, owner: dir, prefix: '', empty: { schema: HARNESS_SCHEMA } };
  }
  if (target.kind === 'main') {
    const dir = mainDirOf(tree);
    if (dir === undefined) return fail('workspace.json', 'mainAgent is null; the workspace has no main-agent harness');
    return { path: `${dir}/main-harness.json`, dir, schema: mainHarnessSchema, owner: dir, prefix: '', empty: { schema: 'lousho.main-harness/1' } };
  }
  if (pageDoc(tree, target.page) === undefined) return missingPage(target.page);
  const dir = `pages/${target.page}/harness`;
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

function mainAgentFiles(workspaceName: string, instructions?: string): Entry[] {
  return [
    { path: 'main-agent/agent.json', doc: { name: 'main', version: '1.0.0', description: `Routes work in ${workspaceName}.` } },
    { path: 'main-agent/instructions.md', doc: instructions ?? 'Route each request to the page that fits it.' },
  ];
}

function createWorkspace(op: Op<'create_workspace'>, tree: WorkspaceTree): Plan {
  if ('workspace.json' in tree) return fail('workspace.json', 'already exists');
  const problem = folderFieldProblem(op.mainAgent);
  if (problem !== undefined) return fail('workspace.json', problem);
  const doc = { schema: 'lousho.workspace/1', id: op.id, name: op.name, version: op.version ?? '0.1.0', description: op.description, ...(op.domain !== undefined && { domain: op.domain }), mainAgent: op.mainAgent ?? null, pages: [] };
  const main = op.mainAgent == null ? [] : mainAgentFiles(op.name, op.mainInstructions);
  return build([{ path: 'workspace.json', doc, schema: workspaceManifestSchema }, ...main]);
}

function folderFieldProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const extra = Object.keys(value).filter((key) => key !== 'dir' && key !== 'inheritsShared');
  return extra.length > 0 ? `mainAgent.${extra[0]} cannot be set by an operation; the main agent uses ./main-agent and its default harness folder` : undefined;
}

function setWorkspaceField(op: Op<'set_workspace_field'>, tree: WorkspaceTree): Plan {
  const problem = op.field === 'mainAgent' ? folderFieldProblem(op.value) : undefined;
  if (problem !== undefined) return fail('workspace.json', problem);
  const plan = setDocField(tree, 'workspace.json', workspaceManifestSchema, op.field, op.value);
  if (op.field !== 'mainAgent' || !('writes' in plan)) return plan;
  if (op.value === null) return { ...plan, deletes: Object.keys(tree).filter((path) => path.startsWith('main-agent/') && isAllowedWrite(path)) };
  return isRecord(manifestOf(tree)?.mainAgent) ? plan : withMainAgentFiles(tree, plan);
}

function withMainAgentFiles(tree: WorkspaceTree, plan: { writes: Record<string, unknown>; deletes?: string[] }): Plan {
  const name = str(manifestOf(tree)?.name) ?? 'the workspace';
  const files = mainAgentFiles(name).filter((entry) => !(entry.path in tree));
  return { ...plan, writes: { ...plan.writes, ...Object.fromEntries(files.map((entry) => [entry.path, entry.doc])) } };
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

function agentDir(name: string, page?: string): string {
  return page === undefined ? `agents/${name}` : `pages/${page}/agents/${name}`;
}

function createAgent(op: Op<'create_agent'>, tree: WorkspaceTree): Plan {
  if (op.page !== undefined && pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const dir = agentDir(op.name, op.page);
  if (`${dir}/agent.json` in tree) return fail(`${dir}/agent.json`, `agent '${op.name}' already exists`);
  const spec = { name: op.name, version: op.version ?? '1.0.0', description: op.description, ...(op.model !== undefined && { model: op.model }) };
  return build([{ path: `${dir}/agent.json`, doc: spec }, { path: `${dir}/instructions.md`, doc: op.instructions }]);
}

function writeMainProse(op: Op<'write_agent_prose'>, tree: WorkspaceTree): Plan {
  if (op.agent !== undefined || op.page !== undefined) return fail('target', "target 'main' takes no agent or page");
  return mainDirOf(tree) === undefined ? fail('workspace.json', 'mainAgent is null; there is no main agent') : build([{ path: 'main-agent/instructions.md', doc: op.text }]);
}

function writeAgentProse(op: Op<'write_agent_prose'>, tree: WorkspaceTree): Plan {
  if (op.target === 'main') return writeMainProse(op, tree);
  if (op.agent === undefined) return fail('agent', "needs an agent name, or target 'main'");
  const dir = agentDir(op.agent, op.page);
  if (!(`${dir}/agent.json` in tree)) return fail(`${dir}/agent.json`, `agent '${op.agent}' does not exist`);
  return build([{ path: `${dir}/instructions.md`, doc: op.text }]);
}

function agentsFile(tree: WorkspaceTree, page: string): { path: string; doc: Doc } | Plan {
  const doc = pageDoc(tree, page);
  if (doc === undefined) return missingPage(page);
  const path = `pages/${page}/agents.json`;
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

const R13_RULES: readonly ForbiddenKeyRule[] = [{ keys: FORBIDDEN_HARNESS_KEYS, message: (at, key) => `${at}: ${key} is granted by policy and the runtime, never by a document (R13)` }];

function plainData(value: unknown, root: string): { data: unknown } | Problem[] {
  const { errors, data } = checkForbiddenKeys(value, R13_RULES, root);
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
  const written = writePageDoc(tree, op.page, 'goal.json', op.goal);
  if ('problems' in written) return written;
  return build([{ path: `pages/${op.page}/goal.json`, doc: written.writes[`pages/${op.page}/goal.json`], schema: goalSchema }]);
}

const UI_REL = 'ui/page.ui.json';

function writePageUi(op: Op<'write_page_ui'>, tree: WorkspaceTree): Plan {
  return writePageDoc(tree, op.page, UI_REL, op.ui);
}

function resetPageUi(op: Op<'reset_page_ui'>, tree: WorkspaceTree): Plan {
  if (pageDoc(tree, op.page) === undefined) return missingPage(op.page);
  const path = `pages/${op.page}/${UI_REL}`;
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

const NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const PROSE = '[A-Za-z0-9][A-Za-z0-9._-]*\\.md';
const ALLOWED_PATHS: readonly RegExp[] = [
  /^workspace\.json$/,
  new RegExp(`^harness/(?:harness\\.json|${PROSE})$`),
  new RegExp(`^main-agent/(?:agent\\.json|instructions\\.md|harness/(?:main-harness\\.json|${PROSE}))$`),
  new RegExp(`^agents/${NAME}/(?:agent|instructions)\\.(?:json|md)$`),
  new RegExp(`^pages/${NAME}/(?:page\\.json|agents\\.json|workflow\\.json|goal\\.json|ui/page\\.ui\\.json|harness/(?:harness\\.json|${PROSE})|agents/${NAME}/(?:agent|instructions)\\.(?:json|md))$`),
  new RegExp(`^shared/instructions/${PROSE}$`),
];
const PAGE_FOLDER = new RegExp(`^pages/${NAME}/`);

const isSafePath = (path: string): boolean => !path.includes('\\') && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
const isAllowedWrite = (path: string): boolean => isSafePath(path) && ALLOWED_PATHS.some((pattern) => pattern.test(path));
const isAllowedDelete = (path: string): boolean => isAllowedWrite(path) || (isSafePath(path) && PAGE_FOLDER.test(path));

function pathProblems(plan: { writes: Record<string, unknown>; deletes?: string[] }): Problem[] {
  const refused = [...Object.keys(plan.writes).filter((path) => !isAllowedWrite(path)), ...(plan.deletes ?? []).filter((path) => !isAllowedDelete(path))];
  return refused.map((path) => ({ path, message: 'is outside the paths authoring operations may change' }));
}

function harnessTargetOf(op: AuthoringOp): ProseTarget | undefined {
  switch (op.op) {
    case 'write_harness_prose':
    case 'add_criterion':
    case 'remove_criterion':
      return op.target;
    case 'set_harness_field':
    case 'attach_agent':
    case 'detach_agent':
    case 'set_attachment_field':
    case 'write_page_ui':
    case 'reset_page_ui':
      return { kind: 'page', page: op.page };
    case 'set_base_harness_field':
      return { kind: 'base' };
    case 'set_main_harness_field':
      return { kind: 'main' };
    default:
      return undefined;
  }
}

function customPage(tree: WorkspaceTree, page: string): boolean {
  const doc = pageDoc(tree, page);
  if (doc === undefined) return false;
  const harness = isRecord(doc.harness) ? doc.harness : {};
  return doc.ui !== undefined || doc.agents !== undefined || harness.overrides !== undefined;
}

function customTarget(tree: WorkspaceTree, target: ProseTarget): boolean {
  const manifest = manifestOf(tree);
  if (target.kind === 'page') return customPage(tree, target.page);
  if (target.kind === 'base') return manifest?.harness !== undefined;
  return isRecord(manifest?.mainAgent) && manifest.mainAgent.harness !== undefined;
}

function usesCustomPath(op: AuthoringOp, tree: WorkspaceTree): boolean {
  const target = harnessTargetOf(op);
  if (target !== undefined) return customTarget(tree, target);
  const workspaceAgent = (op.op === 'create_agent' || op.op === 'write_agent_prose') && op.page === undefined;
  return workspaceAgent && manifestOf(tree)?.agents !== undefined;
}

export function planOp(op: AuthoringOp, tree: WorkspaceTree): Plan {
  if (usesCustomPath(op, tree)) return fail('workspace.json', 'this workspace or page uses a custom folder or file path; edit it by hand, operations only write the default paths');
  return (HANDLERS[op.op] as (op: AuthoringOp, tree: WorkspaceTree) => Plan)(op, tree);
}

export function applyOp(state: State, op: AuthoringOp, opIndex: number): State {
  const plan = planOp(op, state.tree);
  const problems = 'problems' in plan ? plan.problems : pathProblems(plan);
  if ('problems' in plan || problems.length > 0) return { ...state, problems: problems.map((problem) => ({ opIndex, op: op.op, ...problem })) };
  const tree: Record<string, unknown> = { ...state.tree, ...plan.writes };
  const touched = new Map(state.touched);
  for (const path of plan.deletes ?? []) delete tree[path];
  for (const path of [...Object.keys(plan.writes), ...(plan.deletes ?? [])]) touched.set(path, opIndex);
  return { tree, problems: [], touched };
}

function treeProblem(problem: AuthoringTreeProblem): AuthoringProblem {
  if (problem.file === undefined) return problem;
  return { ...problem, path: problem.file, message: problem.path === '' ? problem.message : `${problem.path}: ${problem.message}` };
}

const isError = (problem: AuthoringTreeProblem): boolean => (problem.severity ?? 'error') === 'error';

export function finalProblems(tree: WorkspaceTree, touched: Map<string, number>, ops: readonly AuthoringOp[], validate: AuthoringValidator): AuthoringProblem[] {
  return validate(tree).filter(isError).map(treeProblem).map((problem) => {
    const opIndex = touched.get(problem.path);
    return opIndex === undefined ? problem : { opIndex, op: ops[opIndex]?.op, ...problem };
  });
}
