import { schemaProblems, type InputProblem } from '../client/inputs';
import type { EffectiveHarness } from '../contracts/compose';
import type { ArtifactRef, ArtifactSink, PageEngine, PageErrorKind, PageInput, PageResult, PageRunContext, PageRunEvent, PageUsage } from '../contracts/execution';
import { pageSchema, type PageManifest } from '../contracts/page';
import { narrowPolicy, workspacePolicySchema, type EffectivePolicy, type WorkspacePolicy } from '../contracts/policy';
import { SHARED_POLICY_FILE } from '../contracts/shared';
import { pageUiSchema } from '../contracts/ui';
import { joinPath } from '../contracts/validateModel';
import { engineFor } from './engines';
import type { EngineRegistry, PageAttachment, PageEngineSetup, PageRuntimeHost } from './engines/types';
import type { LoadedWorkspace, LoadWorkspaceOptions } from './loadWorkspace';
import { pagePolicy } from './policy';
import { jsonOf } from './profileStore';
import { resolveAttachments } from './resolveAgents';
import { profileStoreFor, resolvePageHarness } from './resolveHarness';
import { resolveSharedContext, type SharedContextRun } from './sharedContext';

/** What {@link runPage} needs besides the workspace and the input. */
export interface PageRuntimeContext {
  /** The host's tools, policy ceiling, providers and global resolution. */
  host: PageRuntimeHost;
  /** This run's id; the page's session id. */
  runId: string;
  /** Where the run writes artifacts. */
  artifacts: ArtifactSink;
  /** Aborts the run. */
  signal?: AbortSignal;
  /** Receives the run's events. */
  emit?: (event: PageRunEvent) => void;
  /** The earlier run's result when `input.revise` names one; the page never sees that run's transcript. */
  prior?: PageResult;
  /** Engines by execution type; defaults to `ENGINES`. */
  engines?: EngineRegistry;
  /** The load mode for agent resolution (default `default`). */
  mode?: LoadWorkspaceOptions['mode'];
  /** The workspace run this page belongs to, so its pages and the main agent share one set of shared memory instances. */
  sharedRun?: SharedContextRun;
}

const EMPTY_POLICY: WorkspacePolicy = { permissions: [], tools: { allow: [] }, secrets: [] };

export const EMPTY_USAGE: PageUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function readPage(workspace: LoadedWorkspace, pageId: string): PageManifest {
  const path = `pages/${pageId}/page.json`;
  return pageSchema.parse(jsonOf(workspace.tree[path], path));
}

export function effectivePolicy(workspace: LoadedWorkspace, host: PageRuntimeHost): EffectivePolicy {
  const file = workspace.tree[SHARED_POLICY_FILE];
  const own = file === undefined ? EMPTY_POLICY : workspacePolicySchema.parse(jsonOf(file, SHARED_POLICY_FILE));
  return narrowPolicy(host.ceiling, own);
}

function uiTitle(workspace: LoadedWorkspace, page: PageManifest): string | undefined {
  const path = joinPath(`pages/${page.id}`, page.ui ?? 'ui/page.ui.json');
  if (workspace.tree[path] === undefined) return undefined;
  const parsed = pageUiSchema.safeParse(jsonOf(workspace.tree[path], path));
  return parsed.success ? parsed.data.title : undefined;
}

function taskOf(workspace: LoadedWorkspace, page: PageManifest, task: string): string {
  return task.trim() === '' ? (uiTitle(workspace, page) ?? page.id) : task;
}

function schemaOf(schema: Record<string, unknown> | string | undefined): Record<string, unknown> | undefined {
  return typeof schema === 'object' ? schema : undefined;
}

function describe(problems: readonly InputProblem[]): string {
  return problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
}

function failed(runId: string, kind: PageErrorKind, message: string, usage: PageUsage = EMPTY_USAGE, artifacts: ArtifactRef[] = []): PageResult {
  return { status: 'failed', artifacts, summary: message, usage, runId, error: { kind, message } };
}

async function engineSetup(workspace: LoadedWorkspace, page: PageManifest, harness: EffectiveHarness, ctx: PageRuntimeContext): Promise<PageEngineSetup> {
  const { host } = ctx;
  const resolved = await resolveAttachments(workspace, page.id, { mode: ctx.mode ?? 'default', ...(host.globalAgents && { globalRegistry: host.globalAgents }) });
  const policy = pagePolicy(
    effectivePolicy(workspace, host),
    { capabilities: harness.capabilities?.require ?? [], attachments: resolved.map((item) => ({ alias: item.alias, agentOwned: item.agentOwned, pageOwned: item.pageOwned })) },
    host.tools
  );
  const attachments: Record<string, PageAttachment> = Object.fromEntries(resolved.map((item) => [item.alias, { resolved: item, policy: policy.attachments[item.alias] }]));
  return {
    workspace,
    page,
    harness,
    shared: resolveSharedContext(workspace, { audience: { page: page.id }, ...(ctx.sharedRun && { run: ctx.sharedRun }), ...(host.createMemory && { createMemory: host.createMemory }) }),
    attachments,
    host,
    ...(ctx.prior && { prior: ctx.prior }),
  };
}

function recordingSink(sink: ArtifactSink, emit: (event: PageRunEvent) => void, stored: Map<string, ArtifactRef>): ArtifactSink {
  return {
    async put(name, data, mediaType) {
      const ref = await sink.put(name, data, mediaType);
      stored.set(ref.name, ref);
      emit({ type: 'artifact', artifact: ref });
      return ref;
    },
  };
}

function withArtifacts(result: PageResult, stored: ReadonlyMap<string, ArtifactRef>): PageResult {
  const all = new Map(stored);
  for (const ref of result.artifacts) all.set(ref.name, ref);
  return { ...result, artifacts: [...all.values()] };
}

function outputProblems(harness: EffectiveHarness, result: PageResult): InputProblem[] {
  const schema = schemaOf(harness.outputs?.schema);
  const shape = schema === undefined ? [] : schemaProblems(schema, result.output, 'output');
  const names = new Set(result.artifacts.map((ref) => ref.name));
  const missing = (harness.outputs?.artifacts ?? []).filter((artifact) => artifact.required === true && !names.has(artifact.name));
  return [...shape, ...missing.map((artifact) => ({ path: `artifacts.${artifact.name}`, message: `the required artifact '${artifact.name}' (${artifact.mediaType}) was not produced` }))];
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function addUsage(a: PageUsage, b: PageUsage): PageUsage {
  const costUsd = sum(a.costUsd, b.costUsd);
  const modelCalls = sum(a.modelCalls, b.modelCalls);
  const costPartial = a.costPartial === true || b.costPartial === true;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(costUsd !== undefined && { costUsd }),
    ...(costPartial && { costPartial }),
    ...(modelCalls !== undefined && { modelCalls }),
  };
}

interface Attempt {
  engine: PageEngine;
  input: PageInput;
  ctx: PageRunContext;
  harness: EffectiveHarness;
  stored: ReadonlyMap<string, ArtifactRef>;
}

async function attempt(run: Attempt, input: PageInput): Promise<{ result: PageResult; problems: InputProblem[] }> {
  const result = withArtifacts(await run.engine.run(input, run.ctx), run.stored);
  return { result, problems: result.status === 'ok' ? outputProblems(run.harness, result) : [] };
}

async function runValidated(run: Attempt): Promise<PageResult> {
  const first = await attempt(run, run.input);
  if (first.problems.length === 0) return first.result;
  const instruction = `your output failed: ${describe(first.problems)}. Answer again with output that fixes every problem.`;
  const second = await attempt(run, { ...run.input, revise: { runId: run.ctx.runId, instruction } });
  const usage = addUsage(first.result.usage, second.result.usage);
  if (second.problems.length === 0) return { ...second.result, usage };
  return failed(run.ctx.runId, 'invalid-output', `the output is still invalid after one repair turn: ${describe(second.problems)}`, usage, second.result.artifacts);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const noop = (): void => undefined;

/** Runs one page: validates `input.inputs` against the effective `inputs.schema` (failing `invalid-input` before any model call), picks the engine by `execution.type`, runs it in its own session with the page's limits, then validates the output and the required artifacts, giving one repair turn before failing `invalid-output`. The page gets only the task, its inputs and, for a revise, the prior result. */
export async function runPage(workspace: LoadedWorkspace, input: PageInput, ctx: PageRuntimeContext): Promise<PageResult> {
  const emit = ctx.emit ?? noop;
  const page = readPage(workspace, input.pageId);
  const harness = resolvePageHarness(workspace, page.id, profileStoreFor(workspace, ctx.host.globalProfiles));
  const inputSchema = schemaOf(harness.inputs?.schema);
  const invalid = inputSchema === undefined ? [] : schemaProblems(inputSchema, input.inputs, 'inputs');
  if (invalid.length > 0) {
    emit({ type: 'finished', status: 'failed', usage: EMPTY_USAGE });
    return failed(ctx.runId, 'invalid-input', `the inputs are invalid: ${describe(invalid)}`);
  }
  const factory = engineFor(page.execution.type, ctx.engines);
  const engine = factory(await engineSetup(workspace, page, harness, ctx));
  const labels = { page: page.id, harnessHash: harness.hash, executionType: page.execution.type };
  const stored = new Map<string, ArtifactRef>();
  const runCtx: PageRunContext = {
    runId: ctx.runId,
    signal: ctx.signal ?? new AbortController().signal,
    limits: page.execution.limits ?? {},
    labels,
    artifacts: recordingSink(ctx.artifacts, emit, stored),
    emit,
  };
  const pageInput: PageInput = { pageId: page.id, task: taskOf(workspace, page, input.task), ...(input.inputs !== undefined && { inputs: input.inputs }), ...(input.revise && { revise: input.revise }) };
  emit({ type: 'started', ...labels });
  const result = await runValidated({ engine, input: pageInput, ctx: runCtx, harness, stored }).catch((error: unknown) => failed(ctx.runId, 'engine', errorMessage(error), EMPTY_USAGE, [...stored.values()]));
  emit({ type: 'finished', status: result.status, usage: result.usage });
  return result;
}
