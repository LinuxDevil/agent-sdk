import path from 'node:path';
import { isDefinedTool, type DefinedTool } from '../tools/defineTool';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';

const TOOL_FILE = /\.[cm]?[jt]s$/;
const NOT_A_TOOL_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\./;

/** A tool and the file that exported it. */
export interface LoadedTool {
  tool: DefinedTool;
  file: string;
}

const EXAMPLE = `Expected a tool made with defineTool(), for example:

  import { z } from 'zod';
  import { defineTool } from '@loushy/build-ai-agent';
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
    '(if it is, check the file imports defineTool from the same copy of @loushy/build-ai-agent that loads the directory)'
  );
}

async function loadToolFile(file: string): Promise<DefinedTool[]> {
  const mod = await importModule(file);
  const exported = [mod.default, ...Object.entries(mod).filter(([k]) => k !== 'default').map(([, v]) => v)];
  const unique = [...new Set(exported.flatMap((v) => toolsIn(v)))];
  if (unique.length === 0) {
    throw new Error(`loadAgentDir: ${file}: ${describeExports(mod)}. ${EXAMPLE}`);
  }
  return unique;
}

/**
 * Loads every `tools/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by file
 * name). Each file may default-export a tool, and/or export several tools by
 * name or as an array. Duplicate tool names across files are an error.
 */
export async function loadTools(dir: string): Promise<LoadedTool[]> {
  const toolsDir = path.join(dir, 'tools');
  const names = await listSorted(toolsDir, (e) => e.isFile && TOOL_FILE.test(e.name) && !NOT_A_TOOL_FILE.test(e.name));
  const byName = new Map<string, LoadedTool>();
  for (const name of names) {
    const file = path.join(toolsDir, name);
    for (const tool of await loadToolFile(file)) {
      const earlier = byName.get(tool.name);
      if (earlier) {
        throw new Error(
          `loadAgentDir: duplicate tool name '${tool.name}' in ${earlier.file} and ${file}. ` +
            'Rename one of the tools - the model addresses tools by name.'
        );
      }
      byName.set(tool.name, { tool, file });
    }
  }
  return [...byName.values()];
}
