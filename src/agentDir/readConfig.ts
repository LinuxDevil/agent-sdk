import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isFile, readText } from './fsUtil';
import { importModule } from './importModule';
import { fail, validateConfig, type AgentDirConfig } from './validateConfig';
import { SDKError } from '../execution/errors';

export type { AgentDirConfig } from './validateConfig';

/** Config file names, in the order they are looked for. At most one may exist. */
const CONFIG_FILES = [
  'agent.ts',
  'agent.mts',
  'agent.js',
  'agent.mjs',
  'agent.cjs',
  'agent.json',
  'agent.yaml',
  'agent.yml',
] as const;

const DATA_CONFIG = /\.(?:json|ya?ml)$/;

/** True for an `agent.ts` / `.js` style config file (imported as code), false for JSON/YAML (parsed as data). */
export function isCodeConfigFile(file: string): boolean {
  return !DATA_CONFIG.test(file);
}

function parseText(file: string, kind: 'JSON' | 'YAML', text: string): unknown {
  try {
    return kind === 'JSON' ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    return fail(file, `invalid ${kind} (${(error as Error).message}).`);
  }
}

async function parseConfigFile(file: string): Promise<unknown> {
  const ext = path.extname(file);
  if (ext === '.json') return parseText(file, 'JSON', await readText(file));
  if (ext === '.yaml' || ext === '.yml') return parseText(file, 'YAML', await readText(file));
  const mod = await importModule(file);
  return 'default' in mod ? mod.default : mod;
}

/** The config file found in `dir` (or none) and its validated contents. */
export interface ReadConfigResult {
  file: string | undefined;
  config: AgentDirConfig;
}

/** The one config file in `dir`, or undefined. More than one throws LOUSHO_AGENT_DIR_INVALID. */
export async function findConfigFile(dir: string): Promise<string | undefined> {
  const found: string[] = [];
  for (const name of CONFIG_FILES) {
    const file = path.join(dir, name);
    if (await isFile(file)) found.push(file);
  }
  if (found.length > 1) {
    throw new SDKError(
      `loadAgentDir: ${dir} has more than one config file (${found.map((f) => path.basename(f)).join(', ')}). Keep exactly one.`,
      'LOUSHO_AGENT_DIR_INVALID'
    );
  }
  return found[0];
}

/** Finds, parses and validates `dir`'s config file. A directory without one has an empty config. */
export async function readConfig(dir: string): Promise<ReadConfigResult> {
  const file = await findConfigFile(dir);
  if (file === undefined) return { file, config: {} };
  return { file, config: validateConfig(file, await parseConfigFile(file)) };
}
