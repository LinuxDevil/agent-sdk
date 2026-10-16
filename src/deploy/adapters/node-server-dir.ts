/**
 * Agent directories as a node-server / docker deployment source (LOU-P8.2).
 *
 * Decision: the directory is pre-bundled, not copied as TypeScript. Its code
 * files (agent config, auth.ts, tools, schedules, channels, memory, and the same inside
 * each sub-agent) are compiled by the adapter's own tsup/esbuild step into
 * `dist/agent/**.js` next to `dist/server.js`, in one ESM build with shared
 * chunks (so tools, channels and the server use one copy of the SDK), and the
 * files `resolveAgentDir()` reads as data (instructions.md, instructions/,
 * skills/, a JSON/YAML config) are copied - an allowlist, so `.env` files and
 * the `.lousho` session store never reach the build. The built server
 * then runs `resolveAgentDir('dist/agent')` on plain JavaScript: no TypeScript
 * loader, no node_modules and no sources are needed where it runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listSorted } from '../../agentDir/fsUtil';
import { findConfigFile, isCodeConfigFile, readConfig } from '../../agentDir/readConfig';
import { writeFile } from '../bundle';
import { SDKError } from '../../execution/errors';
import { RECEIPT_FILE } from '../../cli/addReceipt';
/** Root code files the config may point at, beyond the config itself: route auth, the hooks file and the approver file. */
const ROOT_CODE_FILE = /^(agent|auth|hooks|approve)\.[cm]?[jt]s$/;

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

/** Code files in `folder` (or, without one, the config file and, at the root only, `auth.*`, `hooks.*` and `approve.*`). */
async function codeFiles(dir: string, folder: string | undefined, isRoot: boolean): Promise<string[]> {
  const where = folder ? path.join(dir, folder) : dir;
  const keep = (e: { name: string; isFile: boolean }) =>
    e.isFile && CODE.test(e.name) && !NOT_CODE.test(e.name) && (folder !== undefined || (isRoot ? ROOT_CODE_FILE : /^(agent|hooks|approve)\.[cm]?[jt]s$/).test(e.name));
  return (await listSorted(where, keep)).map((name) => path.join(where, name));
}

async function collectEntries(dir: string, root: string, entries: Record<string, string>): Promise<void> {
  for (const file of (await Promise.all([undefined, ...CODE_FOLDERS].map((f) => codeFiles(dir, f, dir === root)))).flat()) {
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

/** A data config file: copied as is (an `agent.ts` / `.js` config is bundled instead). */
const DATA_CONFIG_FILE = /^agent\.(?:json|ya?ml)$/;
/** The folders of an agent directory copied whole (minus code files and {@link neverCopied} names). */
const COPIED_FOLDERS = new Set(['instructions', 'skills']);

/**
 * Names never copied, at any depth: `.env` files (secrets), `.lousho` (the
 * default file store, real user transcripts), `.git`, `node_modules`, and the
 * install receipt (its hashes name the `.ts` sources `lousho add` wrote, which
 * the bundle compiles to `.js`, so copied it would only report its own items
 * as modified).
 */
function neverCopied(name: string): boolean {
  return SKIPPED.has(name) || name === '.lousho' || /^\.env(?:\.|$)/.test(name) || name === RECEIPT_FILE;
}

/** The absolute `store.dir` a JSON/YAML config declares (a code config's is only known when it runs). */
async function dataConfigStoreDir(dir: string): Promise<string | undefined> {
  const file = await findConfigFile(dir);
  if (file === undefined || isCodeConfigFile(file)) return undefined;
  const store = (await readConfig(dir)).config.store as { dir?: unknown } | undefined;
  return typeof store?.dir === 'string' ? path.resolve(dir, store.dir) : undefined;
}

/** Copies `dir`'s allowlisted assets to `dest`: the data config, instructions.md, instructions/, skills/ and the same in each sub-agent. */
async function copyAssets(dir: string, dest: string): Promise<void> {
  const storeDir = await dataConfigStoreDir(dir);
  const keep = (file: string) =>
    !neverCopied(path.basename(file)) && path.resolve(file) !== storeDir && !(fs.statSync(file).isFile() && CODE.test(file));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (!keep(from)) continue;
    if (entry.isFile() && (entry.name === 'instructions.md' || DATA_CONFIG_FILE.test(entry.name))) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(from, path.join(dest, entry.name));
    } else if (entry.isDirectory() && COPIED_FOLDERS.has(entry.name)) {
      fs.cpSync(from, path.join(dest, entry.name), { recursive: true, filter: keep });
    } else if (entry.isDirectory() && entry.name === 'subagents') {
      for (const name of await listSorted(from, (e) => e.isDirectory && !e.name.startsWith('.'))) {
        await copyAssets(path.join(from, name), path.join(dest, 'subagents', name));
      }
    }
  }
}

/**
 * Copies the non-code files `resolveAgentDir()` reads from `source`
 * (instructions.md, instructions/, skills/, a JSON/YAML config, and the same
 * in each sub-agent) to `dist/agent` and marks `dist` as ESM. It is an
 * allowlist: anything else in the directory (`.env`, the `.lousho` session
 * store or the config's `store.dir`, notes, data files) stays out of the
 * build and so out of a Docker image.
 */
export async function copyAgentDirAssets(source: string, outDir: string): Promise<void> {
  await copyAssets(source, path.join(outDir, 'dist', 'agent'));
  // server.js and the bundled agent files use import/export.
  writeFile(path.join(outDir, 'dist', 'package.json'), '{ "type": "module" }\n');
}
