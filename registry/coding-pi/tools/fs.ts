/**
 * The kit's workspace tools: every file tool and a shell limited to an allow
 * list. The workspace is the agent directory itself - the kit works on the
 * project it is installed into, and `lousho build` bundles this file next to
 * the agent so the built server's workspace is the bundled directory.
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
  WorkspaceCheckpoints,
} from '@lousho/build-ai-agent';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const workspace = new NodeWorkspace({ root });
export const checkpoints = new WorkspaceCheckpoints(workspace, {
  store: new FileWorkspaceCheckpointStore(path.join(root, '.lousho', 'checkpoints')),
});

export const fs = createFsTools(workspace, { checkpoints });

/** A shell that only runs the commands a coding harness needs. */
export const shell = createShellTool(workspace, {
  needsApproval: false,
  allow: ['node --test', 'git status', 'git diff'],
});

export default fs;
