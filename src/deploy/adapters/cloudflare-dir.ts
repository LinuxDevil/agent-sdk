/**
 * Agent directories as a cloudflare-worker deployment source (M3b).
 *
 * A Worker has no file system and cannot `import()` an arbitrary path, so
 * `resolveAgentDir()` cannot run there. Instead `scaffold()` reads the
 * directory on Node and writes `agent.module.ts`: a static import of every
 * tool file (same selection as `loadTools()`) and of an `agent.ts` / `agent.js`
 * config, plus `instructions.md`, a JSON/YAML config and the skills embedded as
 * JSON literals. The generated worker.ts hands that module's `agentDir` to the
 * Worker runtime (`handleWorkerAgentDirRequest`, src/deploy/runtime.worker.ts),
 * which builds the agent with the same rules as `resolveAgentDir()`.
 *
 * Imports point at the directory's own files (relative to the output
 * directory), so a tool's relative imports and its `node_modules` resolve as
 * they do in development. What needs a file system, a long-running process or
 * more Worker plumbing (sub-agents, schedules, channels, memory slots,
 * `projectInstructions`) is refused here with the folder or key to remove.
 */
import * as path from 'node:path';
import { isToolFileName } from '../../agentDir/collectTools';
import { isDirectory, listSorted } from '../../agentDir/fsUtil';
import { readInstructions } from '../../agentDir/loadAgentDir';
import { findConfigFile, isCodeConfigFile, readConfig } from '../../agentDir/readConfig';
import { loadSkills } from '../../skills/loadSkills';
import type { Skill } from '../../skills/defineSkill';
import { SDKError } from '../../execution/errors';
import { WORKER_RUNTIME_SPECIFIER, writeFile } from '../bundle';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { resolveWorkerAgentDir } from '../workerAgentDir';
import { assertAgentDirLayout } from './node-server-dir';

/** Folders of an agent directory the Worker target refuses, and why. */
const UNSUPPORTED_FOLDERS: Record<string, string> = {
  subagents: 'sub-agents',
  schedules: 'schedules (cron triggers)',
  channels: 'channels',
  memory: 'memory slots',
};

async function assertNoUnsupportedFolders(dir: string): Promise<void> {
  for (const [folder, what] of Object.entries(UNSUPPORTED_FOLDERS)) {
    if (await isDirectory(path.join(dir, folder))) {
      throw new SDKError(
        `cloudflare-worker: the agent directory '${dir}' has a '${folder}/' folder, but the cloudflare-worker target ` +
          `does not support ${what} from an agent directory yet. Remove '${folder}/', or use --target=node-server or --target=docker.`,
        'LOUSHO_DEPLOY_FAILED'
      );
    }
  }
}

/** An import specifier for `file` from a module in `outDir`. */
function importSpecifier(outDir: string, file: string): string {
  const relative = path.relative(outDir, file);
  // A file on another drive (Windows) has no relative path: import it by its absolute one.
  if (path.isAbsolute(relative)) return file.replace(/\\/g, '/');
  const specifier = relative.replace(/\\/g, '/');
  return specifier.startsWith('../') ? specifier : `./${specifier}`;
}

interface DirSources {
  name: string;
  instructions?: string;
  configFile?: string;
  /** The config's absolute path when it is code (imported); undefined for JSON/YAML or none. */
  configCode?: string;
  config?: unknown;
  tools: string[];
  skills: Skill[];
}

async function readDirSources(dir: string): Promise<DirSources> {
  const configPath = await findConfigFile(dir);
  const code = configPath !== undefined && isCodeConfigFile(configPath);
  const config = configPath === undefined || code ? undefined : (await readConfig(dir)).config;
  const toolsDir = path.join(dir, 'tools');
  const toolNames = await listSorted(toolsDir, (e) => e.isFile && isToolFileName(e.name));
  const skillsDir = path.join(dir, 'skills');
  const skills = (await isDirectory(skillsDir)) ? await loadSkills(skillsDir) : [];
  return {
    name: path.basename(dir),
    ...(await readInstructions(dir).then((found) => (found ? { instructions: found.text } : {}))),
    ...(configPath === undefined ? {} : { configFile: path.basename(configPath) }),
    ...(code ? { configCode: configPath } : {}),
    ...(config === undefined ? {} : { config }),
    tools: toolNames.map((name) => path.join(toolsDir, name)),
    skills: skills.map(({ name, description, content }) => ({ name, description, content })),
  };
}

/** `agent.module.ts`: the directory as static imports and JSON literals (never raw file contents in code). */
function agentModuleSource(sources: DirSources, dir: string, outDir: string): string {
  const imports = sources.tools.map((file, i) => `import * as tool${i} from ${JSON.stringify(importSpecifier(outDir, file))};`);
  if (sources.configCode) imports.push(`import * as agentConfig from ${JSON.stringify(importSpecifier(outDir, sources.configCode))};`);
  const toolEntries = sources.tools.map(
    (file, i) => `    { file: ${JSON.stringify(path.relative(dir, file).replace(/\\/g, '/'))}, module: tool${i} },`
  );
  const fields = [
    `  name: ${JSON.stringify(sources.name)},`,
    ...(sources.instructions === undefined ? [] : [`  instructions: ${JSON.stringify(sources.instructions)},`]),
    ...(sources.configFile === undefined ? [] : [`  configFile: ${JSON.stringify(sources.configFile)},`]),
    ...(sources.configCode ? ['  configModule: agentConfig,'] : []),
    ...(sources.config === undefined ? [] : [`  config: ${JSON.stringify(sources.config)},`]),
    toolEntries.length === 0 ? '  toolModules: [],' : ['  toolModules: [', ...toolEntries, '  ],'].join('\n'),
    `  skills: ${JSON.stringify(sources.skills)},`,
  ];
  return [
    '/**',
    ' * Generated by `lousho build --target=cloudflare-worker` from an agent directory.',
    ' * Rebuild instead of editing: the tools and an agent.ts config are imported from',
    ' * the directory; instructions.md, a JSON/YAML config and the skills are copied in.',
    ' */',
    `import type { WorkerAgentDir } from '${WORKER_RUNTIME_SPECIFIER}';`,
    ...imports,
    '',
    'export const agentDir: WorkerAgentDir = {',
    ...fields,
    '};',
    '',
  ].join('\n');
}

const WORKER_DIR_TS = `/**
 * Generated by \`lousho build --target=cloudflare-worker\` from an agent directory.
 *
 *   GET  /health                         -> 200 'ok'
 *   POST /chat                           -> { sessionId, input } in, the turn streamed as SSE out
 *                                           (the deprecated { message, sessionId? } returns an
 *                                           ExecutionResult)
 *   GET  /chat/:sessionId                -> the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  -> { approved, note? } or { answer }, streamed
 *
 * Worker bindings (see wrangler.toml): the \`LOUSHO_API_TOKEN\` secret makes every
 * route except /health require 'Authorization: Bearer <token>'; the provider API
 * key is a secret named <TYPE>_API_KEY (e.g. OPENAI_API_KEY); the
 * \`${CHECKPOINT_KV_BINDING}\` KV namespace keeps sessions, checkpoints and approvals between
 * requests (without it they live in the memory of one isolate).
 */
import { handleWorkerAgentDirRequest, prepareWorkerAgentDir } from '${WORKER_RUNTIME_SPECIFIER}';
import { agentDir } from './agent.module';

// Checks the config and the tool files when the Worker starts, not on its first request.
prepareWorkerAgentDir(agentDir);

export async function fetch(request: Request, env: Record<string, unknown> = {}): Promise<Response> {
  return handleWorkerAgentDirRequest(request, env, agentDir);
}

export default { fetch };
`;

/**
 * Scaffolds the Worker of the agent directory `agentPath` into `outDir`:
 * agent.module.ts and worker.ts. Returns the agent's name for wrangler.toml.
 * A JSON/YAML config is checked here (provider, `projectInstructions`,
 * instructions); an `agent.ts` config is checked when the Worker starts.
 */
export async function scaffoldWorkerAgentDir(agentPath: string, outDir: string): Promise<string> {
  const dir = path.resolve(agentPath);
  assertAgentDirLayout(dir);
  await assertNoUnsupportedFolders(dir);
  const sources = await readDirSources(dir);
  let name = sources.name;
  if (!sources.configCode) {
    name = resolveWorkerAgentDir({
      name: sources.name,
      ...(sources.instructions === undefined ? {} : { instructions: sources.instructions }),
      ...(sources.configFile === undefined ? {} : { configFile: sources.configFile, config: sources.config }),
      toolModules: [],
      skills: sources.skills,
    }).name;
  }
  writeFile(path.join(outDir, 'agent.module.ts'), agentModuleSource(sources, dir, outDir));
  writeFile(path.join(outDir, 'worker.ts'), WORKER_DIR_TS);
  return name;
}
