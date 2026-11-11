import { flowProblems, flowSpecSchema, type FlowProblem } from '../../spec/v2/flow';
import { attachmentsSchema, type Attachments } from './agentRefs';
import { harnessSchema, type Harness } from './harness';
import { findNestedPages, pageSchema, type PageManifest } from './page';
import { pageUiSchema } from './ui';
import { layerProblems } from './validateLayers';
import { agentFolder, dotted, layerFileProblems, folderOf, goalCriteria, harnessCode, isRecord, joinPath, problem, readDoc, subtree, type Ctx, type Issue, type PageView, type WorkspaceProblem, type WorkspaceProblemCode } from './validateModel';

const EMPTY_HARNESS: Harness = { schema: 'lousho.harness/1' };
const EMPTY_ATTACHMENTS: Attachments = { schema: 'lousho.agents/1', agents: [] };

function pageCode(issue: Issue): WorkspaceProblemCode {
  return issue.message.includes('nested pages are not supported') ? 'PRD009' : 'PRD008';
}

function agentsCode(issue: Issue): WorkspaceProblemCode {
  if (issue.message.endsWith('(R13)')) return 'PRD005';
  return issue.path[issue.path.length - 1] === 'ref' ? 'PRD007' : 'PRD006';
}

function withDefault<T>(ctx: Ctx, file: string, read: { data?: T; problems: WorkspaceProblem[] }, fallback: T | undefined): { data?: T; problems: WorkspaceProblem[] } {
  return file in ctx.tree ? read : { data: fallback, problems: [] };
}

function nestedProblems(ctx: Ctx, dir: string): WorkspaceProblem[] {
  return findNestedPages(Object.keys(subtree(ctx.tree, dir))).map((path) => problem('PRD009', `${dir}/${path}`, '', 'nested pages are not supported in v1'));
}

function readPage(ctx: Ctx, id: string): { view: PageView; problems: WorkspaceProblem[] } {
  const dir = `pages/${id}`;
  const pagePath = `${dir}/page.json`;
  const page = readDoc(ctx, pagePath, pageSchema, pageCode);
  const agentsPath = joinPath(dir, page.data?.agents ?? 'agents.json');
  const harnessPath = joinPath(joinPath(dir, page.data?.harness.overrides ?? 'harness'), 'harness.json');
  const uiPath = joinPath(dir, page.data?.ui ?? 'ui/page.ui.json');
  const agents = withDefault(ctx, agentsPath, readDoc(ctx, agentsPath, attachmentsSchema, agentsCode), EMPTY_ATTACHMENTS);
  const harness = withDefault(ctx, harnessPath, readDoc(ctx, harnessPath, harnessSchema, (issue) => harnessCode(issue.message, 'PRD003')), EMPTY_HARNESS);
  const ui = readDoc(ctx, uiPath, pageUiSchema, () => 'PRD010');
  const view: PageView = { id, dir, pagePath, page: page.data, agentsPath, attachments: agents.data, harnessPath, harness: harness.data, uiPath, ui: ui.data };
  return { view, problems: [...page.problems, ...nestedProblems(ctx, dir), ...agents.problems, ...harness.problems, ...ui.problems] };
}

function executionAliases(page: PageManifest): [string, string][] {
  const { single, multiAgent, goal } = page.execution;
  const team = (block: string, value: { lead: string; delegates?: string[] } | undefined): [string, string][] =>
    value ? [[`${block}.lead`, value.lead], ...(value.delegates ?? []).map((alias, index): [string, string] => [`${block}.delegates.${index}`, alias])] : [];
  return [...(single ? [['single.agent', single.agent] as [string, string]] : []), ...team('multiAgent', multiAgent), ...team('goal', goal)];
}

function aliasProblems(_ctx: Ctx, view: PageView): WorkspaceProblem[] {
  if (!view.page || !view.attachments) return [];
  const aliases = view.attachments.agents.map((agent) => agent.as);
  return executionAliases(view.page)
    .filter(([, alias]) => !aliases.includes(alias))
    .map(([path, alias]) => problem('PRD018', view.pagePath, `execution.${path}`, `execution.${path} names alias '${alias}', which agents.json does not define`));
}


function refProblems(ctx: Ctx, view: PageView): WorkspaceProblem[] {
  return (view.attachments?.agents ?? []).flatMap((agent, index) => {
    const folder = agentFolder(ctx, view, agent.ref);
    if (folder === undefined || `${folder}/agent.json` in ctx.tree) return [];
    return [problem('PRD020', view.agentsPath, `agents.${index}.ref`, `${agent.ref} has no folder ${folder}`)];
  });
}

function workflowFile(ctx: Ctx, view: PageView, ref: string): string {
  return ref === './workflow.json' ? `${view.dir}/workflow.json` : `${folderOf(ctx, 'workflows')}/${ref.slice('workspace:'.length)}/workflow.json`;
}

function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((node, key) => (isRecord(node) || Array.isArray(node) ? (node as Record<string | number, unknown>)[key] : undefined), root);
}

function flowProblem(file: string, doc: unknown, item: FlowProblem): WorkspaceProblem {
  const path = item.path.slice(1);
  const alias = path[path.length - 1] === 'agent' ? valueAt(doc, path) : undefined;
  if (typeof alias !== 'string' || !item.message.startsWith('no subagent')) return problem('PRD030', file, dotted(path), item.message);
  const step = valueAt(doc, path.slice(0, -1));
  const id = isRecord(step) ? String(step.id) : '?';
  return problem('PRD019', file, dotted(path), `step '${id}' names alias '${alias}', which agents.json does not define`);
}

function workflowProblems(ctx: Ctx, view: PageView): WorkspaceProblem[] {
  const ref = view.page?.execution.workflow?.workflow;
  if (ref === undefined) return [];
  const file = workflowFile(ctx, view, ref);
  if (!(file in ctx.tree)) return [problem('PRD030', file, '', `is missing; ${view.pagePath} runs the workflow ${ref}`)];
  const read = readDoc(ctx, file, flowSpecSchema, () => 'PRD030', false);
  if (!read.data || !view.attachments) return read.problems;
  const aliases = view.attachments.agents.map((agent) => agent.as);
  return flowProblems(ctx.tree[file], { agentNames: aliases }).map((item) => flowProblem(file, ctx.tree[file], item));
}


function goalFileProblems(ctx: Ctx, view: PageView): WorkspaceProblem[] {
  if (!view.page?.execution.goal) return [];
  const file = `${view.dir}/goal.json`;
  if (!(file in ctx.tree)) return [problem('PRD030', file, '', `is missing; ${view.pagePath} has a goal block`)];
  if (ctx.broken.has(file) || goalCriteria(ctx.tree[file]) !== undefined) return [];
  return [problem('PRD030', file, 'checks', 'checks must be a list of { criterion } entries')];
}

function listedFileProblems(ctx: Ctx, view: PageView): WorkspaceProblem[] {
  if (!view.harness) return [];
  return layerFileProblems(ctx, { dir: view.dir, file: view.harnessPath, files: subtree(ctx.tree, view.dir) }, view.harness, true);
}

const PAGE_CHECKS: readonly ((ctx: Ctx, view: PageView) => WorkspaceProblem[])[] = [aliasProblems, refProblems, workflowProblems, goalFileProblems, listedFileProblems, layerProblems];

function onePage(ctx: Ctx, id: string): WorkspaceProblem[] {
  const { view, problems } = readPage(ctx, id);
  return [...problems, ...PAGE_CHECKS.flatMap((check) => check(ctx, view))];
}

export function pageProblems(ctx: Ctx): WorkspaceProblem[] {
  return ctx.manifest.pages.filter((id) => `pages/${id}/page.json` in ctx.tree).flatMap((id) => onePage(ctx, id));
}
