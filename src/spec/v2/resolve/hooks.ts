/**
 * hooksFromSpec(): `spec.hooks` as the `AgentHook`s createAgent({ hooks })
 * takes, in spec order. A `{ file }` entry imports the default export of a
 * code file inside `host.baseDir` (`specFilePath` refuses escaping paths;
 * the compiled sibling is tried when the source name is absent) — the
 * export is one hook or a list of them, keeping their own names. An
 * `{ inline }` entry's `code` is never evaluated by the SDK: it goes to
 * `host.inlineHook`, the host's sandboxed runner (Studio's hookSandbox), and
 * the hook it builds is renamed to the entry `id` so a `hook:<id>` node maps
 * to it. Disabled inline hooks are left out; two surviving hooks with the
 * same `name` are an error (HookRegistry would keep only the last).
 * Node-side, like the rest of `resolve/` — it reads files and imports code.
 */
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { importModule } from '../../../agentDir/importModule';
import { ConfigurationError } from '../../../execution/errors';
import type { AgentHook } from '../../../execution/hooks';
import { specFilePath } from '../files';
import type { HookSpec, InlineHookSpec } from '../hooks';

/** What hooksFromSpec needs from the host; S16's host extends it. */
export interface HookHost {
  /** Directory file hooks resolve against. */
  baseDir?: string;
  /**
   * Builds the AgentHook for an inline hook (Studio: runs `code` in its SandboxAdapter). The returned hook's
   * `name` is replaced by `id`. Absent → inline hooks are unsupported on this host.
   */
  inlineHook?(hook: InlineHookSpec & { id: string }): AgentHook;
}

/** The compiled twin of a missing source file (`.ts` → `.js`, `.mts` → `.mjs`, `.cts` → `.cjs`), like loadAgentDir's. */
const COMPILED_SIBLING: Record<string, string> = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs' };

/** Whether `file` exists and is a regular file. */
async function isFile(file: string): Promise<boolean> {
  const stats = await stat(file).catch(() => undefined);
  return stats?.isFile() ?? false;
}

/** `abs` when it exists, else its compiled sibling when that exists, else undefined. */
async function existingFile(abs: string): Promise<string | undefined> {
  if (await isFile(abs)) return abs;
  const ext = path.extname(abs);
  const sibling = COMPILED_SIBLING[ext] === undefined ? undefined : `${abs.slice(0, -ext.length)}${COMPILED_SIBLING[ext]}`;
  return sibling !== undefined && (await isFile(sibling)) ? sibling : undefined;
}

/**
 * One `{ inline }` entry's hook: `host.inlineHook` builds it from the spec
 * (`id` included) and it is renamed to `id`. A disabled entry yields none;
 * a host without `inlineHook` cannot run inline code at all.
 */
function inlineHookOf(entry: { id: string; inline: InlineHookSpec }, index: number, host: HookHost): AgentHook[] {
  const field = `hooks.${index}`;
  if (entry.inline.enabled === false) return [];
  if (host.inlineHook === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' is inline code, which this host cannot run (it has no hook sandbox).`,
      field,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  return [{ ...host.inlineHook({ id: entry.id, ...entry.inline }), name: entry.id }];
}

/**
 * One `{ file }` entry's hooks: the file's default export — a hook or a list
 * — inside `host.baseDir`. The file itself or its compiled sibling must
 * exist; `importModule`'s own error explains an unloadable file.
 */
async function fileHooksOf(entry: { id: string; file: string }, index: number, host: HookHost): Promise<AgentHook[]> {
  const field = `hooks.${index}`;
  if (host.baseDir === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' needs a base folder to load hook files from; this host gave none.`,
      field,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const fileField = `${field}.file`;
  const abs = await existingFile(specFilePath(host.baseDir, fileField, entry.file));
  if (abs === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${fileField}' points at '${entry.file}', which does not exist in ${host.baseDir}.`,
      fileField,
      'LOUSHO_SPEC_INVALID'
    );
  }
  const exported = (await importModule(abs)).default;
  const list = Array.isArray(exported) ? exported : [exported];
  if (
    list.length === 0 ||
    !list.every((hook) => typeof hook === 'object' && hook !== null && typeof (hook as AgentHook).name === 'string')
  ) {
    throw new ConfigurationError(
      `AgentSpec v2: ${abs}: the default export must be a hook ({ name, preToolCall, ... }) or a list of them.`,
      fileField,
      'LOUSHO_SPEC_INVALID'
    );
  }
  return list as AgentHook[];
}

/** The loader of each entry kind, keyed so the dispatch is a lookup, not a switch. */
const ENTRY_HOOKS: Record<'file' | 'inline', (entry: HookSpec, index: number, host: HookHost) => Promise<AgentHook[]>> = {
  file: (entry, index, host) =>
    'file' in entry
      ? fileHooksOf(entry, index, host)
      : Promise.reject(
          new ConfigurationError(`AgentSpec v2: 'hooks.${index}' is not a hook spec.`, `hooks.${index}`, 'LOUSHO_SPEC_INVALID')
        ),
  inline: (entry, index, host) =>
    'inline' in entry
      ? Promise.resolve(inlineHookOf(entry, index, host))
      : Promise.reject(
          new ConfigurationError(`AgentSpec v2: 'hooks.${index}' is not a hook spec.`, `hooks.${index}`, 'LOUSHO_SPEC_INVALID')
        ),
};

/** Two hooks named the same would silently collapse in HookRegistry (it keeps the last): refuse them instead. */
function assertUniqueNames(hooks: readonly AgentHook[]): void {
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (seen.has(hook.name)) {
      throw new ConfigurationError(
        `AgentSpec v2: two hooks are named '${hook.name}'; HookRegistry would keep only the last.`,
        'hooks',
        'LOUSHO_SPEC_INVALID'
      );
    }
    seen.add(hook.name);
  }
}

/**
 * `spec.hooks` as createAgent({ hooks }), in order. Disabled inline hooks
 * are left out. A file entry without `host.baseDir` and an inline entry
 * without `host.inlineHook` are LOUSHO_SPEC_UNSUPPORTED; a missing file, a
 * bad default export and duplicate hook names are LOUSHO_SPEC_INVALID.
 */
export async function hooksFromSpec(hooks: readonly HookSpec[], host: HookHost): Promise<AgentHook[]> {
  const loaded: AgentHook[] = [];
  for (let index = 0; index < hooks.length; index++) {
    const entry = hooks[index];
    loaded.push(...(await ENTRY_HOOKS['file' in entry ? 'file' : 'inline'](entry, index, host)));
  }
  assertUniqueNames(loaded);
  return loaded;
}
