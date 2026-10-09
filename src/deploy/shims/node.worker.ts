/**
 * Worker-safe stand-in for the Node builtins `createAgent()` reaches (LOU-D51).
 *
 * The Worker runtime serves its API with a `createAgent()` agent, whose module
 * graph imports `node:fs`, `node:path`, `node:crypto` & co. for features a
 * Worker cannot use (project instructions, the file session store, guardrail
 * patches, MCP over stdio). The cloudflare adapter's build points exactly those
 * imports (see workerNodeShimPlugin in ../bundle.ts) here: every export fails
 * when called, except `randomUUID`, which has a Web Crypto equivalent. Loading
 * is side-effect free, so nothing breaks until such a feature is actually used.
 */

function unavailable(): never {
  throw new Error('This feature needs Node.js (a file system, child processes or stdio) and is not available on Cloudflare Workers');
}

export const randomUUID = (): string => globalThis.crypto.randomUUID();
// node:crypto: `createHash` names a forked session whose id is too long (AgentSession).
export const createHash = unavailable;

// node:fs, node:fs/promises, node:os, node:path
export const existsSync = unavailable;
export const readFileSync = unavailable;
export const statSync = unavailable;
export const mkdtempSync = unavailable;
export const cpSync = unavailable;
export const writeFileSync = unavailable;
export const rmSync = unavailable;
export const readFile = unavailable;
export const writeFile = unavailable;
export const mkdir = unavailable;
export const rename = unavailable;
export const rm = unavailable;
export const open = unavailable;
export const readdir = unavailable;
export const realpath = unavailable;
export const stat = unavailable;
export const tmpdir = unavailable;
export const join = unavailable;
export const resolve = unavailable;
export const dirname = unavailable;
export const basename = unavailable;
export const relative = unavailable;
export const isAbsolute = unavailable;
export const sep = '/';

// node:child_process and node:util: `promisify(execFile)` runs at load time.
export const execFile = unavailable;
export const promisify = (): (() => never) => unavailable;

// @modelcontextprotocol/sdk/client/stdio.js
export const getDefaultEnvironment = (): Record<string, string> => ({});
export class StdioClientTransport {
  constructor() {
    unavailable();
  }
}
