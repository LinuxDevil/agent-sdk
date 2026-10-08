import path from 'node:path';
import { z } from 'zod';
import type { SimpleAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { listSorted } from './fsUtil';
import { SDKError } from '../execution/errors';

/** A sub-agent directory that was resolved into a running agent. */
export interface LoadedSubagent {
  name: string;
  description: string;
  agent: SimpleAgent;
}

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

/**
 * The tool a parent agent calls to hand a task to `subagent`: it runs the
 * sub-agent's own `send()` and returns its final text.
 *
 * Until `createAgent` has a native `subagents` option this is how
 * sub-agent directories are wired in.
 */
export function delegateTool(subagent: LoadedSubagent): DefinedTool {
  return defineTool({
    name: `delegate_to_${subagent.name}`,
    description: `Delegate a task to the '${subagent.name}' agent. ${subagent.description}`,
    input: z.object({ task: z.string().describe('The complete task for the agent, with all needed context') }),
    execute: async ({ task }, ctx) => {
      const result = await subagent.agent.send(task, { signal: ctx.abortSignal });
      if (result.finishReason !== 'awaiting-approval') return result.text;
      // Nobody can resolve a sub-agent's pause (its agent is not exposed), so say why it stopped instead of returning ''.
      return (
        `The '${subagent.name}' agent stopped: one of its tool calls needs approval, and a sub-agent's approvals are ` +
        'decided only by an `approve` callback passed to loadAgentDir() in code. The call did not run.' +
        (result.text ? ` Its answer so far: ${result.text}` : '')
      );
    },
  });
}
