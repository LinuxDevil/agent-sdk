/**
 * Agent directories as a cloudflare-worker deployment source (M3b, and #298
 * for `subagents/` / `schedules/` / `channels/` / `memory/` /
 * `projectInstructions`).
 *
 * A Worker has no file system and cannot `import()` an arbitrary path, so
 * `resolveAgentDir()` cannot run there. Instead `scaffold()` reads the
 * directory on Node and writes `agent.module.ts`: a static import of every
 * code file (tools, `schedules/`, `channels/` and `memory/` files, an
 * `agent.ts` / `agent.js` config - each `subagents/<name>/` directory
 * recursively), plus `instructions.md`, a JSON/YAML config, the skills and,
 * when the config's `projectInstructions` asks for it, the AGENTS.md /
 * CLAUDE.md text embedded as JSON literals. The generated worker.ts hands
 * that module's `agentDir` to the Worker runtime
 * (`handleWorkerAgentDirRequest`, src/deploy/runtime.worker.ts), which builds
 * the agent with the same rules as `resolveAgentDir()`, mounts the channels
 * under `/channels` and runs the schedules from the Worker's `scheduled()`
 * export (their cron expressions reach `wrangler.toml`'s `[triggers] crons`,
 * read by evaluating the schedule files at scaffold time).
 *
 * Imports point at the directory's own files (relative to the output
 * directory), so a tool's relative imports and its `node_modules` resolve as
 * they do in development.
 */
import * as path from 'node:path';
import { isToolFileName } from '../../agentDir/collectTools';
import { isDirectory, listSorted } from '../../agentDir/fsUtil';
import { readInstructions } from '../../agentDir/loadAgentDir';
import { findConfigFile, isCodeConfigFile, readConfig } from '../../agentDir/readConfig';
import { listSubagentDirs } from '../../agentDir/subagents';
import { loadSkills } from '../../skills/loadSkills';
import type { Skill } from '../../skills/defineSkill';
import type { AgentDirConfig } from '../../agentDir/validateConfig';
import { loadProjectInstructions } from '../../projectInstructions';
import { defineSchedule, type DefinedSchedule } from '../../schedules/defineSchedule';
import { SDKError } from '../../execution/errors';
import { WORKER_RUNTIME_SPECIFIER, writeFile } from '../bundle';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { evalModule } from '../evalModule';
import { resolveWorkerAgentDir, type WorkerAgentDir } from '../workerAgentDir';
import { assertAgentDirLayout } from './node-server-dir';

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
  schedules: string[];
  channels: string[];
  memory: string[];
  subagents: { name: string; sources: DirSources }[];
  projectInstructions?: { file: string; content: string };
}

/** The `projectInstructions` file to embed, when the directory's config asks for one. */
function embeddedProjectInstructions(dir: string, codeConfig: boolean, config: AgentDirConfig | undefined): { file: string; content: string } | undefined {
  if (codeConfig) {
    // A code config's option is only known at Worker start; embed the default search's
    // result so `projectInstructions: true` finds it there (an options object is refused).
    const found = loadProjectInstructions({ cwd: dir });
    return found === undefined ? undefined : { file: path.basename(found.path), content: found.content };
  }
  const option = config?.projectInstructions;
  if (!option) return undefined;
  const found = loadProjectInstructions(
    option === true
      ? { cwd: dir }
      : { ...(option.cwd === undefined ? { cwd: dir } : { cwd: path.resolve(dir, option.cwd) }), ...(option.files === undefined ? {} : { files: option.files }) }
  );
  return found === undefined ? undefined : { file: path.basename(found.path), content: found.content };
}

/** Names of code files in `dir`'s `folder`, sorted (the same files `loadDefaultExports()` would load). */
async function codeFiles(dir: string, folder: string): Promise<string[]> {
  const where = path.join(dir, folder);
  return (await listSorted(where, (e) => e.isFile && isToolFileName(e.name))).map((name) => path.join(where, name));
}

async function readDirSources(dir: string): Promise<DirSources> {
  const configPath = await findConfigFile(dir);
  const code = configPath !== undefined && isCodeConfigFile(configPath);
  const config = configPath === undefined || code ? undefined : (await readConfig(dir)).config;
  const toolsDir = path.join(dir, 'tools');
  const toolNames = await listSorted(toolsDir, (e) => e.isFile && isToolFileName(e.name));
  const skillsDir = path.join(dir, 'skills');
  const skills = (await isDirectory(skillsDir)) ? await loadSkills(skillsDir) : [];
  const subagents = await listSubagentDirs(dir);
  return {
    name: path.basename(dir),
    ...(await readInstructions(dir).then((found) => (found ? { instructions: found.text } : {}))),
    ...(configPath === undefined ? {} : { configFile: path.basename(configPath) }),
    ...(code ? { configCode: configPath } : {}),
    ...(config === undefined ? {} : { config }),
    tools: toolNames.map((name) => path.join(toolsDir, name)),
    skills: skills.map(({ name, description, content }) => ({ name, description, content })),
    schedules: await codeFiles(dir, 'schedules'),
    channels: await codeFiles(dir, 'channels'),
    memory: await codeFiles(dir, 'memory'),
    subagents: await Promise.all(subagents.map(async (name) => ({ name, sources: await readDirSources(path.join(dir, 'subagents', name)) }))),
    ...(await Promise.resolve(embeddedProjectInstructions(dir, code, config)).then((found) => (found ? { projectInstructions: found } : {}))),
  };
}

/**
 * The schedule a `schedules/` file defines, evaluated at scaffold time (the
 * Worker bundle statically imports the same file; the expression is needed
 * here for `wrangler.toml`'s `[triggers] crons`). Its default export must be
 * a `defineSchedule()` schedule, named after the file stem when it sets no
 * `name` - the `loadSchedules()` rules.
 */
async function evalSchedule(file: string): Promise<DefinedSchedule> {
  const exported = (await evalModule(file)).default;
  const stem = path.basename(file).replace(/\.[cm]?[jt]s$/, '');
  const candidate = exported as { name?: unknown } | null;
  try {
    return defineSchedule({ ...(exported as DefinedSchedule), name: typeof candidate?.name === 'string' ? candidate.name : stem });
  } catch (error) {
    if (error instanceof SDKError && error.code === 'LOUSHO_SCHEDULE_INVALID') {
      throw new SDKError(`loadAgentDir: ${file}: the default export must be a defineSchedule() schedule, for example export default defineSchedule({ cron: '0 9 * * MON', prompt: 'Good morning' }). (${(error as SDKError).detail})`, 'LOUSHO_SCHEDULE_INVALID', { cause: error });
    }
    throw error;
  }
}

/** One directory (or sub-agent) as a `WorkerAgentDir` object literal; `importName` registers its static imports. */
function dirLiteral(sources: DirSources, dir: string, indent: string, importName: (file: string) => string): string {
  const inner = `${indent}  `;
  const modules = (label: string, files: string[]): string[] =>
    files.length === 0
      ? []
      : [
          `${inner}${label}: [`,
          ...files.map((file) => `${inner}  { file: ${JSON.stringify(path.relative(dir, file).replace(/\\/g, '/'))}, module: ${importName(file)} },`),
          `${inner}],`,
        ];
  const fields = [
    `${inner}name: ${JSON.stringify(sources.name)},`,
    ...(sources.instructions === undefined ? [] : [`${inner}instructions: ${JSON.stringify(sources.instructions)},`]),
    ...(sources.configFile === undefined ? [] : [`${inner}configFile: ${JSON.stringify(sources.configFile)},`]),
    ...(sources.configCode ? [`${inner}configModule: ${importName(sources.configCode)},`] : []),
    ...(sources.config === undefined ? [] : [`${inner}config: ${JSON.stringify(sources.config)},`]),
    ...(sources.tools.length === 0 ? [`${inner}toolModules: [],`] : modules('toolModules', sources.tools)),
    `${inner}skills: ${JSON.stringify(sources.skills)},`,
    ...modules('scheduleModules', sources.schedules),
    ...modules('channelModules', sources.channels),
    ...modules('memoryModules', sources.memory),
    ...(sources.subagents.length === 0
      ? []
      : [
          `${inner}subagents: [`,
          ...sources.subagents.flatMap((sub) => [
            `${inner}  { name: ${JSON.stringify(sub.name)}, dir: {`,
            dirLiteral(sub.sources, path.join(dir, 'subagents', sub.name), `${inner}    `, importName),
            `${inner}  } },`,
          ]),
          `${inner}],`,
        ]),
    ...(sources.projectInstructions === undefined ? [] : [`${inner}projectInstructions: ${JSON.stringify(sources.projectInstructions)},`]),
  ];
  return fields.join('\n');
}

/** `agent.module.ts`: the directory as static imports and JSON literals (never raw file contents in code). */
function agentModuleSource(sources: DirSources, dir: string, outDir: string): string {
  const imports: string[] = [];
  let count = 0;
  const importName = (file: string): string => {
    const name = `mod${count++}`;
    imports.push(`import * as ${name} from ${JSON.stringify(importSpecifier(outDir, file))};`);
    return name;
  };
  const literal = dirLiteral(sources, dir, '', importName);
  return [
    '/**',
    ' * Generated by `lousho build --target=cloudflare-worker` from an agent directory.',
    ' * Rebuild instead of editing: the code files (tools, schedules, channels, memory,',
    ' * an agent.ts config - of this directory and each sub-agent) are imported from the',
    ' * directory; instructions.md, a JSON/YAML config, the skills and a project',
    ' * instructions file are copied in.',
    ' */',
    `import type { WorkerAgentDir } from '${WORKER_RUNTIME_SPECIFIER}';`,
    ...imports,
    '',
    'export const agentDir: WorkerAgentDir = {',
    literal,
    '};',
    '',
  ].join('\n');
}

function workerDirTs(hasSchedules: boolean): string {
  return `/**
 * Generated by \`lousho build --target=cloudflare-worker\` from an agent directory.
 *
 *   GET  /health                         -> 200 'ok'
 *   POST /chat                           -> { sessionId, input } in, the turn streamed as SSE out
 *                                           (the deprecated { message, sessionId? } returns an
 *                                           ExecutionResult)
 *   GET  /chat/:sessionId                -> the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  -> { approved, note? } or { answer }, streamed
 *   POST /channels/<name>                -> a channels/ channel's verify -> parse -> turn -> reply${
     hasSchedules
       ? `
 *   scheduled()                          -> the schedules/ crons (wrangler.toml [triggers]) as agent turns`
       : ''
   }
 *
 * Worker bindings (see wrangler.toml): the \`LOUSHO_API_TOKEN\` secret makes every
 * route except /health require 'Authorization: Bearer <token>'; the provider API
 * key is a secret named <TYPE>_API_KEY (e.g. OPENAI_API_KEY); the
 * \`${CHECKPOINT_KV_BINDING}\` KV namespace keeps sessions, checkpoints, approvals and
 * kvMemory() slots between requests (without it they live in the memory of one isolate).
 */
import { handleWorkerAgentDirRequest${hasSchedules ? ', handleWorkerAgentDirScheduled' : ''}, prepareWorkerAgentDir } from '${WORKER_RUNTIME_SPECIFIER}';
import { agentDir } from './agent.module';

// Checks the config and the directory's files when the Worker starts, not on its first request.
prepareWorkerAgentDir(agentDir);

export async function fetch(
  request: Request,
  env: Record<string, unknown> = {},
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<Response> {
  return handleWorkerAgentDirRequest(request, env, agentDir, ctx);
}
${
  hasSchedules
    ? `
/** Runs the schedules/ crons (wrangler.toml \`[triggers] crons\`): one agent turn per matching schedule. */
export async function scheduled(
  controller: { cron: string; scheduledTime?: number },
  env: Record<string, unknown> = {},
  ctx: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  return handleWorkerAgentDirScheduled(controller, env, ctx, agentDir);
}
`
    : ''
}
export default { fetch${hasSchedules ? ', scheduled' : ''} };
`;
}

export interface ScaffoldedWorkerAgentDir {
  /** The agent's name, for wrangler.toml. */
  name: string;
  /** The `schedules/` schedules (evaluated at scaffold time); their crons go to `[triggers] crons`. */
  schedules: DefinedSchedule[];
}

/**
 * The part of `sources` `resolveWorkerAgentDir()` can already check: the
 * name/instructions/config of the directory and, recursively, of each
 * `subagents/<name>/` that does not have a code config (a code config's
 * module only exists in the built Worker - like the top-level's, it is
 * checked at Worker start). No modules: a file's exports cannot be checked
 * before the bundle exists.
 */
function validationStub(sources: DirSources): WorkerAgentDir {
  return {
    name: sources.name,
    ...(sources.instructions === undefined ? {} : { instructions: sources.instructions }),
    ...(sources.configFile === undefined ? {} : { configFile: sources.configFile }),
    ...(sources.config === undefined ? {} : { config: sources.config }),
    toolModules: [],
    skills: [],
    subagents: sources.subagents.filter((sub) => !sub.sources.configCode).map((sub) => ({ name: sub.name, dir: validationStub(sub.sources) })),
  };
}

/**
 * Scaffolds the Worker of the agent directory `agentPath` into `outDir`:
 * agent.module.ts and worker.ts. Returns the agent's name and its `schedules/`
 * schedules for wrangler.toml (`[triggers] crons`). A JSON/YAML config is
 * checked here (provider, `projectInstructions`, instructions); an `agent.ts`
 * config is checked when the Worker starts.
 */
export async function scaffoldWorkerAgentDir(agentPath: string, outDir: string): Promise<ScaffoldedWorkerAgentDir> {
  const dir = path.resolve(agentPath);
  assertAgentDirLayout(dir);
  const sources = await readDirSources(dir);
  let name = sources.name;
  if (!sources.configCode) {
    // Fail the build, not the first request, for what a JSON/YAML config already
    // decides: bad config keys, no model, an unsupported provider, missing
    // instructions - and a sub-agent without a 'description'.
    name = resolveWorkerAgentDir(validationStub(sources)).name;
  }
  const schedules = await Promise.all(sources.schedules.map(evalSchedule));
  writeFile(path.join(outDir, 'agent.module.ts'), agentModuleSource(sources, dir, outDir));
  writeFile(path.join(outDir, 'worker.ts'), workerDirTs(schedules.length > 0));
  return { name, schedules };
}
