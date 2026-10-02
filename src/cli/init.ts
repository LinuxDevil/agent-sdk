/**
 * `lousho init [dir] [options]` - scaffold a runnable project in one command
 * (LOU-D3).
 *
 * This is the one generator. `npm create lousho-agent` (packages/create-lousho-agent)
 * is a thin wrapper that runs this command. See init/templates.ts for what is
 * generated.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectProviderFromEnv, listProviders } from '../providers/providerSpec';
import {
  INIT_USAGE,
  PACKAGE_MANAGERS,
  PROVIDER_NAMES,
  TEMPLATES,
  detectPackageManager,
  expectOneOf,
  parseInitArgs,
  type InitOptions,
  type PackageManager,
  type Template,
} from './init/options';
import { askMissing, type InitAnswers } from './init/prompts';
import { assertWritable, packageNameFor, writeFiles } from './init/scaffold';
import { resolveSdkDependency, type SdkManifest } from './init/sdkDependency';
import { renderProject } from './init/templates';

/** Everything `runInit` touches outside the project directory, so tests can fake it. */
export interface InitEnvironment {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** True when stdin is a terminal, so prompting is possible. */
  interactive: boolean;
  sdk: SdkManifest;
  write: (text: string) => void;
  writeError: (text: string) => void;
  /** Runs a command with inherited stdio in `cwd`; resolves to its exit code. */
  exec: (command: string, args: string[], cwd: string) => Promise<number>;
}

const DEFAULT_DIR = 'my-agent';

function readSdkManifest(): SdkManifest {
  // dist/cli/init.js and src/cli/init.ts both sit two levels below the package root.
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

function exec(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    // One command line through the shell, so npm/pnpm/yarn resolve through their .cmd
    // shims on Windows. Both parts are fixed literals, never user input.
    const child = spawn(`${command} ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** The real environment for the current process. */
export function realInitEnvironment(): InitEnvironment {
  return {
    env: process.env,
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    sdk: readSdkManifest(),
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    exec,
  };
}

interface Choices extends InitAnswers {
  packageManager: PackageManager;
}

/** Validates the flag values that were given, before anything is asked or written. */
function validateFlags(options: InitOptions): void {
  if (options.provider !== undefined) expectOneOf('--provider', options.provider, PROVIDER_NAMES);
  if (options.template !== undefined) expectOneOf('--template', options.template, TEMPLATES);
  if (options.packageManager !== undefined) expectOneOf('--package-manager', options.packageManager, PACKAGE_MANAGERS);
}

/** Flags, then prompts (when a terminal is attached and `--yes` is absent), then defaults. */
async function resolveChoices(options: InitOptions, environment: InitEnvironment): Promise<Choices> {
  const defaults: InitAnswers = {
    dir: DEFAULT_DIR,
    provider: detectProviderFromEnv(environment.env) ?? 'openai',
    template: 'minimal',
  };
  const known = { dir: options.dir, provider: options.provider, template: options.template };
  const defined = Object.fromEntries(Object.entries(known).filter(([, value]) => value !== undefined));
  const answers =
    options.yes || !environment.interactive
      ? { ...defaults, ...defined }
      : await askMissing({ known: defined, defaults });
  return {
    ...answers,
    packageManager: (options.packageManager as PackageManager | undefined) ?? detectPackageManager(environment.env),
  };
}

/** Printed after a failed install: the usual causes, and how to install against a local build of the SDK. */
const INSTALL_FAILED_HINT =
  'Check your network and registry settings, then run the install again in the new directory. To use a local build of the SDK instead, ' +
  're-run with `--sdk-path <SDK checkout or packed .tgz>` (see docs/installation.md#installing-from-a-local-build).\n';

function nextSteps(dir: string, cwd: string, pm: PackageManager, envKey: string, installed: boolean): string {
  const relative = path.relative(cwd, dir) || '.';
  const lines = [`cd ${relative.includes(' ') ? JSON.stringify(relative) : relative}`];
  if (!installed) lines.push(`${pm} install`);
  lines.push(`cp .env.example .env   # then set ${envKey}`, `${pm} run dev`);
  return `\nNext steps:\n${lines.map((line) => `  ${line}`).join('\n')}\n\n(\`${pm} run test\` runs the offline tests; \`${pm} run doctor\` checks your setup.)\n`;
}

/** Runs `git init` and the install; failures are reported, not fatal to generation. */
async function finish(options: InitOptions, choices: Choices, dir: string, environment: InitEnvironment): Promise<boolean> {
  if (options.git && (await environment.exec('git', ['init'], dir)) !== 0) {
    environment.writeError('lousho init: `git init` failed; continuing without a git repository.\n');
  }
  if (!options.install) return false;
  const code = await environment.exec(choices.packageManager, ['install'], dir);
  if (code !== 0) {
    environment.writeError(`lousho init: \`${choices.packageManager} install\` failed (exit ${code}). Run it yourself in ${dir}.\n`);
    environment.writeError(INSTALL_FAILED_HINT);
  }
  return code === 0;
}

async function scaffold(options: InitOptions, environment: InitEnvironment): Promise<number> {
  const choices = await resolveChoices(options, environment);
  const dir = path.resolve(environment.cwd, choices.dir);
  assertWritable(dir, options.force);

  const sdkDependency = resolveSdkDependency(environment.sdk.version, dir, options.sdkPath);
  const files = renderProject({
    name: packageNameFor(dir),
    provider: choices.provider,
    template: choices.template as Template,
    packageManager: choices.packageManager,
    sdkDependency,
    sdk: environment.sdk,
  });
  environment.write(`Creating ${choices.template} ${choices.provider} agent in ${dir}\n`);
  writeFiles(dir, files);

  const installed = await finish(options, choices, dir, environment);
  const envKey = listProviders().find((info) => info.name === choices.provider)!.envKey;
  environment.write(nextSteps(dir, environment.cwd, choices.packageManager, envKey, installed));
  return options.install && !installed ? 1 : 0;
}

/**
 * Entry point behind `lousho init` (and `npm create lousho-agent`). Resolves to
 * the process exit code; usage errors are printed, not thrown.
 */
export async function runInit(argv: string[], environment: InitEnvironment = realInitEnvironment()): Promise<number> {
  try {
    const options = parseInitArgs(argv, environment.env);
    if (options.help) {
      environment.write(`${INIT_USAGE}\n`);
      return 0;
    }
    validateFlags(options);
    return await scaffold(options, environment);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    environment.writeError(`${error.message}\n`);
    return 1;
  }
}
