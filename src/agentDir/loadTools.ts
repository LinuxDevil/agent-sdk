import path from 'node:path';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';
import { collectTools, isToolFileName, type LoadedTool, type ToolModule } from './collectTools';

export type { LoadedTool } from './collectTools';

/**
 * Loads every `tools/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by file
 * name). Each file may default-export a tool, and/or export several tools by
 * name or as an array. Duplicate tool names across files are an error.
 */
export async function loadTools(dir: string): Promise<LoadedTool[]> {
  const toolsDir = path.join(dir, 'tools');
  const names = await listSorted(toolsDir, (e) => e.isFile && isToolFileName(e.name));
  const modules: ToolModule[] = [];
  for (const name of names) {
    const file = path.join(toolsDir, name);
    modules.push({ file, module: await importModule(file) });
  }
  return collectTools(modules);
}
