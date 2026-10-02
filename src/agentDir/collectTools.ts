/**
 * Which files of an agent directory's `tools/` are tool files, and which
 * exports of a loaded tool file are tools. Node-free: `loadTools()` uses it on
 * modules it imports from disk, and the Cloudflare Worker runtime
 * (src/deploy/workerAgentDir.ts) on modules bundled at build time, so the two
 * cannot drift apart.
 */
import { isDefinedTool, type DefinedTool } from '../tools/defineTool';
import { SDKError } from '../execution/errors';

const TOOL_FILE = /\.[cm]?[jt]s$/;
const NOT_A_TOOL_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\./;

/** True for a file name under `tools/` that is loaded as a tool file (`.ts`/`.js`/`.mjs`/`.cjs`/`.mts`/`.cts`, not a `.d.ts`, test or spec file). */
export function isToolFileName(name: string): boolean {
  return TOOL_FILE.test(name) && !NOT_A_TOOL_FILE.test(name);
}

/** A tool and the file that exported it. */
export interface LoadedTool {
  tool: DefinedTool;
  file: string;
}

/** A loaded tool file: its path (for messages) and its module namespace. */
export interface ToolModule {
  file: string;
  module: Record<string, unknown>;
}

const EXAMPLE = `Expected a tool made with defineTool(), for example:

  import { z } from 'zod';
  import { defineTool } from '@lousho/build-ai-agent';
  export default defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });`;

/** Tools found in one exported value: a tool, an array of tools, or (CJS) an exports object of tools. */
function toolsIn(value: unknown, depth = 0): DefinedTool[] {
  if (isDefinedTool(value)) return [value];
  if (Array.isArray(value)) return value.filter(isDefinedTool);
  if (depth === 0 && typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((v) => toolsIn(v, 1));
  }
  return [];
}

function describeExports(mod: Record<string, unknown>): string {
  const names = Object.keys(mod).filter((k) => k !== '__esModule');
  if (names.length === 0) return 'it exports nothing';
  const shown = names.map((n) => `${n}: ${typeof mod[n]}`).join(', ');
  return (
    `it exports { ${shown} } but none of these is a defineTool() tool ` +
    '(if it is, check the file imports defineTool from the same copy of @lousho/build-ai-agent that loads the directory)'
  );
}

/** The tools one tool file exports: its default export and named exports, each a tool or an array of tools. A file with none is an error. */
function toolsOfModule({ file, module: mod }: ToolModule): DefinedTool[] {
  const exported = [mod.default, ...Object.entries(mod).filter(([k]) => k !== 'default').map(([, v]) => v)];
  const unique = [...new Set(exported.flatMap((v) => toolsIn(v)))];
  if (unique.length === 0) {
    throw new SDKError(`loadAgentDir: ${file}: ${describeExports(mod)}. ${EXAMPLE}`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  return unique;
}

/** The tools of `modules`, in order. Duplicate tool names across files throw LOUSHO_AGENT_DIR_INVALID. */
export function collectTools(modules: readonly ToolModule[]): LoadedTool[] {
  const byName = new Map<string, LoadedTool>();
  for (const entry of modules) {
    for (const tool of toolsOfModule(entry)) {
      const earlier = byName.get(tool.name);
      if (earlier) {
        throw new SDKError(
          `loadAgentDir: duplicate tool name '${tool.name}' in ${earlier.file} and ${entry.file}. ` +
            'Rename one of the tools - the model addresses tools by name.',
          'LOUSHO_AGENT_DIR_INVALID'
        );
      }
      byName.set(tool.name, { tool, file: entry.file });
    }
  }
  return [...byName.values()];
}
