import path from 'node:path';
import { listSorted } from './fsUtil';
import { SDKError } from '../execution/errors';

// The delegation itself has no Node builtins, so the Worker runtime shares it (./subagentDelegation.ts).
export { delegateTool, routeSubagentApprovals, type LoadedSubagent } from './subagentDelegation';

const DIR_NAME = /^[a-zA-Z0-9_-]{1,50}$/;

/** Names of the sub-agent directories under `dir/subagents`, sorted. */
export async function listSubagentDirs(dir: string): Promise<string[]> {
  const names = await listSorted(path.join(dir, 'subagents'), (e) => e.isDirectory && !e.name.startsWith('.'));
  for (const name of names) {
    if (!DIR_NAME.test(name)) {
      throw new SDKError(
        `loadAgentDir: ${path.join(dir, 'subagents', name)}: sub-agent directory names may only contain ` +
          "letters, digits, '_' and '-' (up to 50 characters), because the name becomes a tool name. Rename the directory.",
        'LOUSHO_AGENT_DIR_INVALID'
      );
    }
  }
  return names;
}

/** Returns the description, or throws: the parent model needs it to decide when to delegate. */
export function requireDescription(subagentDir: string, description: string | undefined): string {
  if (description === undefined) {
    throw new SDKError(
      `loadAgentDir: ${subagentDir}: a sub-agent needs a 'description' so the parent agent knows when to ` +
        'delegate to it. Add one to its config, e.g. agent.json: { "description": "Reviews pull requests" }.',
      'LOUSHO_AGENT_DIR_INVALID'
    );
  }
  return description;
}
