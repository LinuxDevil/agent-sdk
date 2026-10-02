/**
 * Agent directories as a node-server / docker deployment source (LOU-P8.2).
 *
 * Decision: the directory is pre-bundled, not copied as TypeScript. Its code
 * files (agent config, tools, schedules, channels, memory, and the same inside
 * each sub-agent) are compiled by the adapter's own tsup/esbuild step into
 * `dist/agent/**.js` next to `dist/server.js`, in one ESM build with shared
 * chunks (so tools, channels and the server use one copy of the SDK), and the
 * rest (instructions.md, skills, JSON/YAML config) is copied. The built server
 * then runs `resolveAgentDir('dist/agent')` on plain JavaScript: no TypeScript
 * loader, no node_modules and no sources are needed where it runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listSorted } from '../../agentDir/fsUtil';
import { writeFile } from '../bundle';
import { SDKError } from '../../execution/errors';

/** Records where the directory lives, so `build(outDir)` can bundle it (`build` only receives `outDir`). */
const AGENT_DIR_POINTER = 'agent-dir.json';

const CODE = /\.[cm]?[jt]s$/;
const NOT_CODE = /\.d\.[cm]?ts$|\.(?:test|spec)\./;
const CODE_FOLDERS = ['tools', 'schedules', 'channels', 'memory'];
const SKIPPED = new Set(['node_modules', '.git']);

export function isAgentDir(agentPath: string): boolean {
  return agentPath !== '' && fs.existsSync(agentPath) && fs.statSync(agentPath).isDirectory();
}

/** Throws LOUSHO_DEPLOY_FAILED unless `agentPath` has an instructions.md or an agent.* config file. */
export function assertAgentDirLayout(agentPath: string): void {
  const looksLikeAgent = fs.readdirSync(agentPath).some((f) => f === 'instructions.md' || /^agent\./.test(f));
  if (!looksLikeAgent) throw new SDKError(`'${agentPath}' is not an agent directory: it has no instructions.md or agent.* config file.`, 'LOUSHO_DEPLOY_FAILED');
}

/** Records `agentPath` as the directory to bundle, or (undefined) removes an earlier record so a spec build is not mistaken for it. */
export function writeAgentDirPointer(outDir: string, agentPath: string | undefined): void {
  const pointer = path.join(outDir, AGENT_DIR_POINTER);
  if (agentPath === undefined) return fs.rmSync(pointer, { force: true });
  assertAgentDirLayout(agentPath);
  writeFile(pointer, JSON.stringify({ source: agentPath }) + '\n');
}

/** The agent directory `scaffold()` recorded in `outDir`, or undefined for a spec build. */
export function scaffoldedAgentDir(outDir: string): string | undefined {
  const pointer = path.join(outDir, AGENT_DIR_POINTER);
  return fs.existsSync(pointer) ? (JSON.parse(fs.readFileSync(pointer, 'utf8')) as { source: string }).source : undefined;
}

async function codeFiles(dir: string, folder: string | undefined): Promise<string[]> {
  const where = folder ? path.join(dir, folder) : dir;
  const keep = (e: { name: string; isFile: boolean }) =>
    e.isFile && CODE.test(e.name) && !NOT_CODE.test(e.name) && (folder !== undefined || /^agent\./.test(e.name));
  return (await listSorted(where, keep)).map((name) => path.join(where, name));
}

async function collectEntries(dir: string, root: string, entries: Record<string, string>): Promise<void> {
  for (const file of (await Promise.all([undefined, ...CODE_FOLDERS].map((f) => codeFiles(dir, f)))).flat()) {
    entries[`agent/${path.relative(root, file).replace(/\\/g, '/').replace(CODE, '')}`] = file;
  }
  for (const name of await listSorted(path.join(dir, 'subagents'), (e) => e.isDirectory)) {
    await collectEntries(path.join(dir, 'subagents', name), root, entries);
  }
}

/** The esbuild entries (`agent/<path>` -> file) of the code files `resolveAgentDir()` imports under `source`, sub-agents included. */
export async function agentDirEntries(source: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  await collectEntries(source, source, entries);
  return entries;
}

/** Copies the non-code files of `source` (instructions, skills, JSON/YAML config) to `dist/agent` and marks `dist` as ESM. */
export function copyAgentDirAssets(source: string, outDir: string): void {
  fs.cpSync(source, path.join(outDir, 'dist', 'agent'), {
    recursive: true,
    filter: (file) => !SKIPPED.has(path.basename(file)) && !(fs.statSync(file).isFile() && CODE.test(file)),
  });
  // server.js and the bundled agent files use import/export.
  writeFile(path.join(outDir, 'dist', 'package.json'), '{ "type": "module" }\n');
}
