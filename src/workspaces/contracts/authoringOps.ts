import { zodSchema } from 'ai';
import { z } from 'zod';
import { modelIdSchema } from '../../spec/v2/common';
import { schemaToJsonSchema } from '../../utils/zodCompat';
import { attachmentObjectSchema, type Attachment } from './agentRefs';
import type { WorkspaceTree } from './baseHarness';
import { KEBAB_CASE, SEMVER } from './common';
import { criterionSchema, type Harness } from './harness';
import { pageObjectSchema, WORK_TYPES, type PageExecution } from './page';
import { workspaceManifestObjectSchema, type WorkspaceManifest } from './workspace';
import { applyOp, finalProblems, planOp } from './authoringOpHandlers';

/** Which harness an operation edits: a page's, or the workspace base harness. */
export type HarnessTarget =
  | {
      /** A page's own harness. */
      kind: 'page';
      /** Page id. */
      page: string;
    }
  | {
      /** The workspace base harness, layer 0 under every page. */
      kind: 'base';
    };

/** Which prose an operation writes: a page's harness, the base harness or the main-agent harness. */
export type ProseTarget =
  | HarnessTarget
  | {
      /** The main-agent harness prose. */
      kind: 'main';
    };

/** Workspace fields `set_workspace_field` may change. */
export type WorkspaceField = 'name' | 'version' | 'description' | 'domain' | 'mainAgent' | 'dependencies' | 'defaults' | 'budget' | 'improve';

/** Page fields `set_page_field` may change. */
export type PageField = 'name' | 'description' | 'domain' | 'improve' | 'platform' | 'defaults' | 'runtime';

/** Harness fields the harness operations may change; `extends` and `instructions` have their own operations. */
export type HarnessField = 'audience' | 'platform' | 'inputs' | 'outputs' | 'capabilities' | 'constraints' | 'evaluation' | 'runtime' | 'context';

/** Main-harness fields `set_main_harness_field` may change. */
export type MainHarnessField = 'routes' | 'clarify' | 'presentation' | 'limits' | 'onPageFailure';

/** Attachment fields `set_attachment_field` may change. */
export type AttachmentField = 'role' | 'model' | 'limits' | 'tools';

/** Execution keys `set_execution_config` may change. */
export type ExecutionKey = 'single' | 'multiAgent' | 'workflow' | 'goal' | 'limits' | 'onFailure' | 'checkpoint';

/** Creates `workspace.json` in a blank workspace. */
export interface CreateWorkspaceOp {
  /** Operation name. */
  op: 'create_workspace';
  /** Workspace id, kebab-case. */
  id: string;
  /** Display name. */
  name: string;
  /** Workspace version (default `0.1.0`). */
  version?: string;
  /** What the workspace is for. */
  description: string;
  /** Business domain label. */
  domain?: string;
  /** The main agent, or `null` for none (default `null`). */
  mainAgent?: WorkspaceManifest['mainAgent'];
  /** Instructions for the main agent, written to `main-agent/instructions.md` when there is one. */
  mainInstructions?: string;
}

/** Sets or, with no value, removes one workspace field. */
export interface SetWorkspaceFieldOp {
  /** Operation name. */
  op: 'set_workspace_field';
  /** The field to change. */
  field: WorkspaceField;
  /** The new value, validated by the `workspace.json` schema; omit to remove an optional field. */
  value?: unknown;
}

/** Adds a page folder with its `page.json`, empty harness and empty `agents.json`, and lists it in `workspace.json`. */
export interface CreatePageOp {
  /** Operation name. */
  op: 'create_page';
  /** Page id, kebab-case, also the folder name. */
  page: string;
  /** Display name. */
  name: string;
  /** What the page does; the main agent routes on it. */
  description: string;
  /** Business domain label. */
  domain?: string;
  /** How the page runs. */
  execution: PageExecution;
}

/** Removes a page folder and its entry in `workspace.json`. */
export interface RemovePageOp {
  /** Operation name. */
  op: 'remove_page';
  /** Page id. */
  page: string;
}

/** Sets the display order of the pages. */
export interface ReorderPagesOp {
  /** Operation name. */
  op: 'reorder_pages';
  /** Every existing page id exactly once, in the new order. */
  pages: string[];
}

/** Sets or, with no value, removes one page field. */
export interface SetPageFieldOp {
  /** Operation name. */
  op: 'set_page_field';
  /** Page id. */
  page: string;
  /** The field to change. */
  field: PageField;
  /** The new value, validated by the `page.json` schema; omit to remove an optional field. */
  value?: unknown;
}

/** Sets or, with no value, removes one field of a page's `harness.json`. */
export interface SetHarnessFieldOp {
  /** Operation name. */
  op: 'set_harness_field';
  /** Page id. */
  page: string;
  /** The field to change. */
  field: HarnessField;
  /** The new value, validated and scanned for forbidden keys by the harness schema; omit to remove the field. */
  value?: unknown;
}

/** Writes a prose `.md` file of a harness and lists it in that harness's `instructions`. */
export interface WriteHarnessProseOp {
  /** Operation name. */
  op: 'write_harness_prose';
  /** The harness the prose belongs to. */
  target: ProseTarget;
  /** The file name inside the harness folder, such as `task.md`. */
  file: string;
  /** The prose. */
  text: string;
}

/** Adds a harness profile ref to a page's `extends`. */
export interface AddExtendsOp {
  /** Operation name. */
  op: 'add_extends';
  /** Page id. */
  page: string;
  /** Profile ref, such as `platforms/instagram`. */
  ref: string;
  /** Position in the list (default last); order matters. */
  index?: number;
}

/** Removes a harness profile ref from a page's `extends`. */
export interface RemoveExtendsOp {
  /** Operation name. */
  op: 'remove_extends';
  /** Page id. */
  page: string;
  /** Profile ref to remove. */
  ref: string;
}

/** Sets or, with no value, removes one field of the base harness, creating it when absent. */
export interface SetBaseHarnessFieldOp {
  /** Operation name. */
  op: 'set_base_harness_field';
  /** The field to change. */
  field: HarnessField;
  /** The new value, validated and scanned for forbidden keys by the harness schema; omit to remove the field. */
  value?: unknown;
}

/** Sets or, with no value, removes one field of the main-agent harness, creating it when absent. */
export interface SetMainHarnessFieldOp {
  /** Operation name. */
  op: 'set_main_harness_field';
  /** The field to change. */
  field: MainHarnessField;
  /** The new value, validated by the main-harness schema; omit to remove the field. */
  value?: unknown;
}

/** Adds an evaluation criterion to a harness. */
export interface AddCriterionOp {
  /** Operation name. */
  op: 'add_criterion';
  /** The harness to add it to. */
  target: HarnessTarget;
  /** The criterion: an id, a description, and a `check`, a `rubric` or both. */
  criterion: NonNullable<Harness['evaluation']>['criteria'][number];
}

/** Removes an evaluation criterion from a harness. */
export interface RemoveCriterionOp {
  /** Operation name. */
  op: 'remove_criterion';
  /** The harness to remove it from. */
  target: HarnessTarget;
  /** Criterion id. */
  id: string;
}

/** Writes a workspace agent, or a page-local one, from a small template: `agent.json` and `instructions.md`. */
export interface CreateAgentOp {
  /** Operation name. */
  op: 'create_agent';
  /** Agent folder name, kebab-case. */
  name: string;
  /** Page id for a page-local agent; omit for a workspace agent. */
  page?: string;
  /** What the agent does. */
  description: string;
  /** Model as `provider/model`. */
  model?: string;
  /** Agent version, semver (default `1.0.0`). */
  version?: string;
  /** The agent's instructions. */
  instructions: string;
}

/** Replaces the instructions prose of a workspace agent, a page-local one, or with `target: 'main'` the main agent's `main-agent/instructions.md`. */
export interface WriteAgentProseOp {
  /** Operation name. */
  op: 'write_agent_prose';
  /** Agent folder name; omit when `target` is `main`. */
  agent?: string;
  /** Page id for a page-local agent; omit for a workspace agent. */
  page?: string;
  /** `main` writes the main agent's instructions. */
  target?: 'main';
  /** The new instructions. */
  text: string;
}

/** Attaches an agent to a page in `agents.json`. */
export interface AttachAgentOp {
  /** Operation name. */
  op: 'attach_agent';
  /** Page id. */
  page: string;
  /** The attachment: alias, ref and page-level narrowing. */
  attachment: Attachment;
}

/** Removes an attachment from a page's `agents.json`. */
export interface DetachAgentOp {
  /** Operation name. */
  op: 'detach_agent';
  /** Page id. */
  page: string;
  /** The attachment alias. */
  as: string;
}

/** Sets or, with no value, removes one field of an attachment. */
export interface SetAttachmentFieldOp {
  /** Operation name. */
  op: 'set_attachment_field';
  /** Page id. */
  page: string;
  /** The attachment alias. */
  as: string;
  /** The field to change. */
  field: AttachmentField;
  /** The new value, validated by the attachment schema; omit to remove the field. */
  value?: unknown;
}

/** Changes only `execution.type` in `page.json`. */
export interface SetExecutionTypeOp {
  /** Operation name. */
  op: 'set_execution_type';
  /** Page id. */
  page: string;
  /** The new active type; its config block must exist. */
  type: PageExecution['type'];
}

/** Sets or, with no value, removes one key of a page's `execution` block. */
export interface SetExecutionConfigOp {
  /** Operation name. */
  op: 'set_execution_config';
  /** Page id. */
  page: string;
  /** The execution key to change. */
  key: ExecutionKey;
  /** The new value, validated by the `page.json` schema; omit to remove the key. */
  value?: unknown;
}

/** Writes a page's `workflow.json`. */
export interface WriteWorkflowOp {
  /** Operation name. */
  op: 'write_workflow';
  /** Page id. */
  page: string;
  /** The workflow document, whose agent names are the page's attachment aliases. Required; an omitted value is rejected. */
  workflow?: unknown;
}

/** Writes a page's `goal.json`. */
export interface WriteGoalOp {
  /** Operation name. */
  op: 'write_goal';
  /** Page id. */
  page: string;
  /** The goal document. Required; an omitted value is rejected. */
  goal?: unknown;
}

/** Writes a page's declarative UI file. */
export interface WritePageUiOp {
  /** Operation name. */
  op: 'write_page_ui';
  /** Page id. */
  page: string;
  /** The page UI document. Required; an omitted value is rejected. */
  ui?: unknown;
}

/** Deletes a page's UI file so the default UI applies. */
export interface ResetPageUiOp {
  /** Operation name. */
  op: 'reset_page_ui';
  /** Page id. */
  page: string;
}

/** Writes one shared instruction file under `shared/instructions/`. */
export interface WriteSharedInstructionOp {
  /** Operation name. */
  op: 'write_shared_instruction';
  /** File name, such as `00-brand-voice.md`; instructions are ordered by name. */
  file: string;
  /** The prose. */
  text: string;
}

/** One typed authoring operation; the closed set that chat and the forms both send. Policy, secrets, the tool catalog and global agents are not in it. */
export type AuthoringOp =
  | CreateWorkspaceOp
  | SetWorkspaceFieldOp
  | CreatePageOp
  | RemovePageOp
  | ReorderPagesOp
  | SetPageFieldOp
  | SetHarnessFieldOp
  | WriteHarnessProseOp
  | AddExtendsOp
  | RemoveExtendsOp
  | SetBaseHarnessFieldOp
  | SetMainHarnessFieldOp
  | AddCriterionOp
  | RemoveCriterionOp
  | CreateAgentOp
  | WriteAgentProseOp
  | AttachAgentOp
  | DetachAgentOp
  | SetAttachmentFieldOp
  | SetExecutionTypeOp
  | SetExecutionConfigOp
  | WriteWorkflowOp
  | WriteGoalOp
  | WritePageUiOp
  | ResetPageUiOp
  | WriteSharedInstructionOp;

/** One problem an operation batch found. */
export interface AuthoringProblem {
  /** Index in the batch of the operation that caused it; absent for a problem in the final tree no operation touched. */
  opIndex?: number;
  /** The operation's name, when `opIndex` is set. */
  op?: string;
  /** The file the problem is in, relative to the workspace root, or the operation field for a malformed operation. */
  path: string;
  /** What is wrong. */
  message: string;
}

/** One problem a whole-tree validator found. */
export interface AuthoringTreeProblem {
  /** The file the problem is in, relative to the workspace root. */
  path: string;
  /** What is wrong. */
  message: string;
}

/** Extra whole-tree validation for {@link applyOps}, such as `validateWorkspace`. */
export type AuthoringValidator = (tree: WorkspaceTree) => AuthoringTreeProblem[];

/** The outcome of {@link applyOps}: the new tree when there are no problems, else the original tree and every problem. */
export interface ApplyOpsResult {
  /** The tree after the operations, or the unchanged input tree when `problems` is not empty. */
  tree: WorkspaceTree;
  /** Every problem found; empty when the operations applied cleanly. */
  problems: AuthoringProblem[];
}

const id = z.string().regex(KEBAB_CASE, 'must be kebab-case');
const text = z.string();
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, 'must be a .md file name with no folder');
const value = z.custom<unknown>(() => true).optional();

const manifest = workspaceManifestObjectSchema.shape;
const page = pageObjectSchema.shape;

const harnessTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('page'), page: id }).strict(), z.object({ kind: z.literal('base') }).strict()]);
const proseTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('page'), page: id }).strict(), z.object({ kind: z.literal('base') }).strict(), z.object({ kind: z.literal('main') }).strict()]);

const harnessFields = z.enum(['audience', 'platform', 'inputs', 'outputs', 'capabilities', 'constraints', 'evaluation', 'runtime', 'context']);

const op = <N extends string, S extends z.ZodRawShape>(name: N, shape: S) => z.object({ op: z.literal(name), ...shape }).strict();

export const authoringOpObjectSchema = z.discriminatedUnion('op', [
  op('create_workspace', { id: manifest.id, name: manifest.name, version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0').optional(), description: manifest.description, domain: manifest.domain, mainAgent: manifest.mainAgent.optional(), mainInstructions: text.optional() }),
  op('set_workspace_field', { field: z.enum(['name', 'version', 'description', 'domain', 'mainAgent', 'dependencies', 'defaults', 'budget', 'improve']), value }),
  op('create_page', { page: id, name: page.name, description: page.description, domain: page.domain, execution: page.execution }),
  op('remove_page', { page: id }),
  op('reorder_pages', { pages: z.array(id) }),
  op('set_page_field', { page: id, field: z.enum(['name', 'description', 'domain', 'improve', 'platform', 'defaults', 'runtime']), value }),
  op('set_harness_field', { page: id, field: harnessFields, value }),
  op('write_harness_prose', { target: proseTarget, file: fileName, text }),
  op('add_extends', { page: id, ref: z.string().min(1, 'must not be empty'), index: z.number().int().min(0).optional() }),
  op('remove_extends', { page: id, ref: z.string().min(1, 'must not be empty') }),
  op('set_base_harness_field', { field: harnessFields, value }),
  op('set_main_harness_field', { field: z.enum(['routes', 'clarify', 'presentation', 'limits', 'onPageFailure']), value }),
  op('add_criterion', { target: harnessTarget, criterion: criterionSchema }),
  op('remove_criterion', { target: harnessTarget, id }),
  op('create_agent', { name: id, page: id.optional(), description: z.string().min(1, 'must not be empty'), model: modelIdSchema.optional(), version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0').optional(), instructions: text }),
  op('write_agent_prose', { agent: id.optional(), page: id.optional(), target: z.literal('main').optional(), text }),
  op('attach_agent', { page: id, attachment: attachmentObjectSchema }),
  op('detach_agent', { page: id, as: id }),
  op('set_attachment_field', { page: id, as: id, field: z.enum(['role', 'model', 'limits', 'tools']), value }),
  op('set_execution_type', { page: id, type: z.enum(WORK_TYPES as unknown as [PageExecution['type'], ...PageExecution['type'][]]) }),
  op('set_execution_config', { page: id, key: z.enum(['single', 'multiAgent', 'workflow', 'goal', 'limits', 'onFailure', 'checkpoint']), value }),
  op('write_workflow', { page: id, workflow: z.custom<unknown>(() => true) }),
  op('write_goal', { page: id, goal: z.custom<unknown>(() => true) }),
  op('write_page_ui', { page: id, ui: z.custom<unknown>(() => true) }),
  op('reset_page_ui', { page: id }),
  op('write_shared_instruction', { file: fileName, text }),
]);

/** Zod schema for one {@link AuthoringOp}: a union on `op` whose payloads reuse the workspace, page, harness and attachment schemas; free-form values are checked against their file's schema, forbidden-key scan included, when the operation is applied; goal and UI documents are scanned for the R13 keys. */
export const authoringOpSchema: z.ZodType<AuthoringOp> = authoringOpObjectSchema as unknown as z.ZodType<AuthoringOp>;

/** The names of every operation, in the order the ticket lists them. */
export const AUTHORING_OP_NAMES: readonly AuthoringOp['op'][] = authoringOpObjectSchema.options.map((option) => option.shape.op.value);

/** JSON Schema (draft 7) of {@link authoringOpSchema}, from which the chat agent's tools are generated. */
export function authoringOpJsonSchema(): Record<string, unknown> {
  const schema = schemaToJsonSchema(authoringOpSchema) ?? (zodSchema(authoringOpSchema as never).jsonSchema as Record<string, unknown>);
  return structuredClone(schema);
}

/** The workspace files `op` would write or delete on `tree`, by path relative to the workspace root; empty when the operation does not apply to `tree`. */
export function opFiles(operation: AuthoringOp, tree: WorkspaceTree): string[] {
  const plan = planOp(operation, tree);
  return 'problems' in plan ? [] : [...Object.keys(plan.writes), ...(plan.deletes ?? [])];
}

function parseOps(ops: readonly unknown[]): { ops: AuthoringOp[]; problems: AuthoringProblem[] } {
  const parsed: AuthoringOp[] = [];
  const problems: AuthoringProblem[] = [];
  ops.forEach((raw, opIndex) => {
    const result = authoringOpSchema.safeParse(raw);
    if (result.success) parsed.push(result.data);
    else problems.push(...result.error.issues.map((issue) => ({ opIndex, path: issue.path.join('.') || 'op', message: issue.message })));
  });
  return { ops: parsed, problems };
}

/** Applies `ops` in order to `tree`, writing only known files at their default paths (never `shared/policies/**`); pure, and `validate` is required so callers pass `validateWorkspace` (P0.10). With any problem the original tree comes back with every problem, each naming its operation index. */
export function applyOps(tree: WorkspaceTree, ops: readonly unknown[], options: { validate: AuthoringValidator }): ApplyOpsResult {
  const parsed = parseOps(ops);
  if (parsed.problems.length > 0) return { tree, problems: parsed.problems };
  const applied = parsed.ops.reduce<{ tree: WorkspaceTree; problems: AuthoringProblem[]; touched: Map<string, number> }>(
    (state, operation, opIndex) => (state.problems.length > 0 ? state : applyOp(state, operation, opIndex)),
    { tree, problems: [], touched: new Map() }
  );
  if (applied.problems.length > 0) return { tree, problems: applied.problems };
  const problems = finalProblems(applied.tree, applied.touched, parsed.ops, options.validate);
  return problems.length > 0 ? { tree, problems } : { tree: applied.tree, problems };
}
