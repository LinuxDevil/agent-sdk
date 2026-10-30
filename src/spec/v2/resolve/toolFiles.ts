/**
 * `{ file }` and `{ registry }` tool-ref resolution for
 * `src/spec/v2/resolve/tools.ts`. A file ref imports one tool file inside the
 * host's `baseDir` (never outside it — `specFilePath` refuses escaping paths);
 * a registry ref resolves a `lousho add` receipt item to the tool files it
 * installed. Both load through `importModule`/`collectTools`, exactly as an
 * agent directory's `tools/` do, and both end confined to the directory's
 * install receipt (`confineToolsToReceipt`): a spec may name registry code but
 * never widen the permission manifest it was installed under. Node-side, like
 * the rest of `resolve/` — it reads files and imports code.
 */
import { stat } from 'node:fs/promises';
import { collectTools, isToolFileName, type LoadedTool, type ToolModule } from '../../../agentDir/collectTools';
import { importModule } from '../../../agentDir/importModule';
import { confineToolsToReceipt, verifyReceipt } from '../../../agentDir/registryEnforce';
import { readReceipt } from '../../../cli/addReceipt';
import { ConfigurationError } from '../../../execution/errors';
import { specFilePath } from '../files';
import type { ResolvedTools, ToolRefHost } from './tools';

/** `host.baseDir` or the LOUSHO_SPEC_UNSUPPORTED throw file/registry refs need first. */
function requireBaseDir(host: ToolRefHost, field: string): string {
  if (host.baseDir === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' needs a base folder to load tool files from; this host gave none.`,
      field,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  return host.baseDir;
}

/**
 * Imports one tool file `rel` inside `baseDir`; a `rel` that escapes the
 * folder is LOUSHO_SPEC_INVALID via `specFilePath`, one that names no file a
 * LOUSHO_SPEC_INVALID naming `field.file`, and an unloadable or tool-less
 * module propagates `importModule`/`collectTools`' LOUSHO_AGENT_DIR_INVALID.
 */
async function loadToolModule(baseDir: string, field: string, rel: string): Promise<ToolModule> {
  const abs = specFilePath(baseDir, `${field}.file`, rel);
  const stats = await stat(abs).catch(() => undefined);
  if (stats === undefined || !stats.isFile()) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}.file' points at '${rel}', which does not exist in ${baseDir}.`,
      field,
      'LOUSHO_SPEC_INVALID'
    );
  }
  return { file: abs, module: await importModule(abs) };
}

/** `loaded` keyed by tool name, with the directory's install receipt enforced on the tools it covers. */
async function confinedRecord(baseDir: string, loaded: LoadedTool[]): Promise<ResolvedTools> {
  const confined = confineToolsToReceipt(baseDir, loaded, await verifyReceipt(baseDir));
  return Object.fromEntries(confined.map(({ tool }) => [tool.name, tool]));
}

/**
 * `{ file: rel }` → the tools `rel` (a code file inside `host.baseDir`)
 * exports, keyed by tool name and confined to the directory's install receipt.
 */
export async function fileRefTools(rel: string, host: ToolRefHost, field: string): Promise<ResolvedTools> {
  const baseDir = requireBaseDir(host, field);
  return confinedRecord(baseDir, collectTools([await loadToolModule(baseDir, field, rel)]));
}

/**
 * `{ registry: name }` → the tools a `lousho add` receipt item installed under
 * `tools/`, keyed by tool name and confined to the manifest the item was
 * installed under (attested or not). A name the receipt does not record, an
 * item of another type and an item with no tool files are errors.
 */
export async function registryRefTools(name: string, host: ToolRefHost, field: string): Promise<ResolvedTools> {
  const baseDir = requireBaseDir(host, field);
  const entry = (await readReceipt(baseDir)).items[name];
  if (entry === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}': registry tool '${name}' is not installed in ${baseDir}. Run \`lousho add ${name} --dir ${baseDir}\`.`,
      field,
      'LOUSHO_REGISTRY_ITEM_NOT_FOUND'
    );
  }
  if (entry.type !== 'tool') {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}': registry item '${name}' is a ${entry.type}, not a tool.`,
      field,
      'LOUSHO_SPEC_INVALID'
    );
  }
  const files = entry.files
    .map((file) => file.path)
    .filter((file) => file.startsWith('tools/') && isToolFileName(file.slice('tools/'.length)))
    .sort();
  if (files.length === 0) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}': registry item '${name}' has no files under tools/.`,
      field,
      'LOUSHO_SPEC_INVALID'
    );
  }
  const modules = await Promise.all(files.map((rel) => loadToolModule(baseDir, field, rel)));
  return confinedRecord(baseDir, collectTools(modules));
}
