import { createAgent, type SimpleAgent } from '../../createAgent';
import type { ToolDescriptor } from '../../types';
import { mainHarnessSchema, type MainHarness } from '../contracts/mainHarness';
import { pageSchema } from '../contracts/page';
import { joinPath, normalizeDir } from '../contracts/validateModel';
import { DEFAULT_MAX_CONCURRENT_PAGES, workspaceManifestSchema, type WorkspaceManifest } from '../contracts/workspace';
import { readAgentOwned } from './agentDirView';
import { assembleMainInstructions, type MainHarnessInput, type MainPageInfo } from './assemble';
import type { PageRuntimeHost } from './engines/types';
import type { LoadedWorkspace } from './loadWorkspace';
import { effectivePolicy } from './pageRuntime';
import { agentPolicyOptions } from './policy';
import { jsonOf } from './profileStore';
import type { SharedContext } from './sharedContext';

const MAIN_DIR = 'main-agent';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

export function workspaceManifest(workspace: LoadedWorkspace): WorkspaceManifest {
  return workspaceManifestSchema.parse(jsonOf(workspace.tree['workspace.json'], 'workspace.json'));
}

function mainHarnessDir(manifest: WorkspaceManifest): string {
  return normalizeDir(manifest.mainAgent?.harness ?? `${MAIN_DIR}/harness`);
}

export function readMainHarness(workspace: LoadedWorkspace, manifest: WorkspaceManifest): MainHarnessInput | undefined {
  const dir = mainHarnessDir(manifest);
  const file = `${dir}/main-harness.json`;
  if (manifest.mainAgent === null || workspace.tree[file] === undefined) return undefined;
  const harness: MainHarness = mainHarnessSchema.parse(jsonOf(workspace.tree[file], file));
  const texts = Object.fromEntries((harness.instructions ?? []).flatMap((name) => {
    const text = workspace.tree[joinPath(dir, name)];
    return text === undefined ? [] : [[name, textOf(text)]];
  }));
  return { harness, texts };
}

export function maxConcurrentPages(manifest: WorkspaceManifest, harness: MainHarness | undefined): number {
  const allowed = manifest.defaults?.limits?.maxConcurrentPages ?? DEFAULT_MAX_CONCURRENT_PAGES;
  return Math.min(allowed, harness?.limits?.maxConcurrentPages ?? allowed);
}

export function mainPages(workspace: LoadedWorkspace, manifest: WorkspaceManifest): MainPageInfo[] {
  return manifest.pages.map((id) => {
    const path = `pages/${id}/page.json`;
    const page = pageSchema.parse(jsonOf(workspace.tree[path], path));
    return { id, name: page.name, description: page.description };
  });
}

function mainFiles(workspace: LoadedWorkspace): Record<string, string> {
  const prefix = `${MAIN_DIR}/`;
  return Object.fromEntries(Object.keys(workspace.tree).filter((path) => path.startsWith(prefix)).map((path) => [path.slice(prefix.length), textOf(workspace.tree[path])]));
}

/** What {@link createMainAgent} builds the main agent from. */
interface MainAgentOptions {
  /** The host's tools, policy ceiling and providers. */
  host: PageRuntimeHost;
  /** The router's tools; the main agent gets them next to its own policy tools. */
  routerTools: Readonly<Record<string, ToolDescriptor>>;
  /** The shared layer resolved for `main-agent`; empty unless `mainAgent.inheritsShared`. */
  shared?: SharedContext;
}

/** Builds the main agent from `main-agent/`: instructions from `assembleMainInstructions` with the main-agent harness when present, its own tools under the shared policy (each bound by the host), the router tools and the shared memory slots. */
export function createMainAgent(workspace: LoadedWorkspace, options: MainAgentOptions): SimpleAgent {
  const { host, shared } = options;
  const manifest = workspaceManifest(workspace);
  const owned = readAgentOwned({ format: 'dir', dir: MAIN_DIR, files: mainFiles(workspace) });
  const mainHarness = readMainHarness(workspace, manifest);
  const instructions = assembleMainInstructions({
    mainAgent: owned,
    ...(shared && { shared }),
    ...(mainHarness && { mainHarness }),
    pages: mainPages(workspace, manifest),
  });
  const policy = agentPolicyOptions(effectivePolicy(workspace, host), { agent: owned }, host.tools);
  const own = Object.fromEntries(
    Object.entries(policy.tools).map(([name, descriptor]) => [
      name,
      host.bindTool(descriptor, { name, page: MAIN_DIR, attachment: MAIN_DIR, secrets: policy.secrets[name] ?? [], network: { allowHosts: [...policy.network.allowHosts] }, sandbox: { required: policy.sandbox.required } }),
    ])
  );
  const model = owned.defaultModel ?? manifest.defaults?.model;
  return createAgent({
    name: owned.name,
    instructions: instructions.text,
    ...(host.provider ? { provider: host.provider(model) } : model !== undefined && { model }),
    tools: { ...own, ...options.routerTools },
    permissions: policy.permissions,
    ...(owned.limits !== undefined && { limits: owned.limits }),
    ...(shared && shared.memorySlots.length > 0 && { memory: shared.memorySlots.map((item) => item.slot) }),
  });
}
