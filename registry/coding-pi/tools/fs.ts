/**
 * The kit's workspace tools: every file tool and a shell limited to an allow
 * list. The workspace is the agent directory itself - the kit works on the
 * project it is installed into, and `lousho build` bundles this file next to
 * the agent so the built server's workspace is the bundled directory.
 *
 * Because the agent's own files share that directory, the file tools refuse
 * to change them: `agent.*`, `approve.*`, `hooks.*`, `instructions*`,
 * `lousho-registry.json`, and everything under `.lousho/`, `tools/`,
 * `skills/`, `subagents/`, `.git/` and `node_modules/`. Without this the
 * model could rewrite its own approver or permissions.
 *
 * `checkpoints` backs up every write and edit (to `.lousho/checkpoints/` in
 * the workspace, so a rewind still works after a restart); `workspace`,
 * `checkpoints` and `fs` are also exported for code that wants the same
 * objects (a test, or another tool file).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFsTools,
  createShellTool,
  FileWorkspaceCheckpointStore,
  NodeWorkspace,
  normalizeWorkspacePath,
  WorkspaceCheckpoints,
  WorkspaceError,
  type FsProvider,
} from '@lousho/build-ai-agent';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const workspace = new NodeWorkspace({ root });
export const checkpoints = new WorkspaceCheckpoints(workspace, {
  store: new FileWorkspaceCheckpointStore(path.join(root, '.lousho', 'checkpoints')),
});

const PROTECTED_DIRS = new Set(['.lousho', 'tools', 'skills', 'subagents', 'instructions', '.git', 'node_modules']);
const PROTECTED_ROOT_FILE = /^(agent|approve|hooks)(\..*)?$|^instructions|^lousho-registry\.json$/;

/** True when `p` names one of the agent's own files (case-insensitive; Windows aliases included). */
export function isAgentFile(p: string): boolean {
  // Windows drops trailing dots and spaces, and `APPROV~1.TS` may alias `approve.ts`.
  const segments = normalizeWorkspacePath(p)
    .split('/')
    .map((s) => s.replace(/[. ]+$/, '').toLowerCase());
  if (segments.some((s) => /~\d/.test(s))) return true;
  if (PROTECTED_DIRS.has(segments[0])) return true;
  return segments.length === 1 && PROTECTED_ROOT_FILE.test(segments[0]);
}

function guard(p: string): void {
  if (isAgentFile(p)) {
    throw new WorkspaceError(`${p} is part of the agent's own configuration and cannot be changed. Change the project's code instead.`);
  }
}

/** The workspace as the file tools see it: reads pass through, writes to the agent's own files are refused. */
const projectFiles: FsProvider = {
  readFile: (p) => workspace.readFile(p),
  stat: (p) => workspace.stat(p),
  readdir: (p) => workspace.readdir(p),
  getMode: (p) => workspace.getMode(p),
  async writeFile(p, content) {
    guard(p);
    return workspace.writeFile(p, content);
  },
  async mkdir(p) {
    guard(p);
    return workspace.mkdir(p);
  },
  async rm(p, options) {
    guard(p);
    return workspace.rm(p, options);
  },
  async chmod(p, mode) {
    guard(p);
    return workspace.chmod(p, mode);
  },
};

export const fs = createFsTools(projectFiles, { checkpoints });

/**
 * A shell that only runs the commands a coding harness needs. `node --test`
 * takes test file paths but no flags (a flag such as
 * `--test-reporter-destination=../x` writes outside the project); `git diff`
 * is left out because `git diff --output=<file>` writes anywhere.
 */
export const shell = createShellTool(workspace, {
  needsApproval: false,
  allow: [/^node --test( (?!-)(?![^ ]*\.\.)[\w./-]+)*$/, /^git status( (-s|--short|--porcelain))?$/],
});

export default fs;
