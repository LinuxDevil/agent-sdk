/**
 * `lousho init [dir] [options]` - scaffold a runnable project in one command.
 *
 * This is the one generator. `npm create lousho` (packages/create-lousho)
 * is a thin wrapper that runs this command. See init/templates.ts for what is
 * generated.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSdkRoot } from '../deploy/bundle';
import { detectProviderFromEnv, listProviders } from '../providers/providerSpec';
import {
  INIT_USAGE,
  InitUsageError,
  PACKAGE_MANAGERS,
  PROVIDER_NAMES,
  TEMPLATES,
  botFlagsUsed,
  detectPackageManager,
  expectOneOf,
  parseInitArgs,
  type InitOptions,
  type PackageManager,
  type Template,
} from './init/options';
import { askMissing, type AskInput, type InitAnswers } from './init/prompts';
import { USAGE_EXIT_CODE } from './args';
import { MissingPeerDependencyError } from '../providers/optionalPeer';
import { assertWritable, packageNameFor, writeFiles } from './init/scaffold';
import { resolveSdkDependency, sdkPathProblem, type SdkManifest } from './init/sdkDependency';
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
  return JSON.parse(fs.readFileSync(path.join(findSdkRoot(), 'package.json'), 'utf8'));
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
  // A bad --sdk-path is a usage error (exit 2), like a bad --provider.
  const sdkPath = options.sdkPath === undefined ? undefined : sdkPathProblem(options.sdkPath);
  if (sdkPath !== undefined) throw new InitUsageError(sdkPath);
}

/**
 * The prompts, or the flags and defaults when the optional `prompts` peer is
 * missing (e.g. `npx lousho init` installs only the SDK):
 * there is nothing to install in an npx run, so say how to choose instead.
 */
async function askOrDefault(input: AskInput, environment: InitEnvironment): Promise<InitAnswers> {
  try {
    return await askMissing(input);
  } catch (error) {
    if (!(error instanceof MissingPeerDependencyError)) throw error;
    environment.writeError(
      "lousho init: interactive prompts need the optional 'prompts' package, which is not installed; using your flags and the defaults. " +
        'Choose with a directory argument, --provider and --template, or run `npm create lousho`, which includes the prompts.\n'
    );
    return { ...input.defaults, ...input.known };
  }
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
      : await askOrDefault({ known: defined, defaults }, environment);
  return {
    ...answers,
    packageManager: (options.packageManager as PackageManager | undefined) ?? detectPackageManager(environment.env),
  };
}

/** Printed after a failed install: the usual causes, and how to install against a local build of the SDK. */
const INSTALL_FAILED_HINT =
  'Check your network and registry settings, then run the install again in the new directory. To use a local build of the SDK instead, ' +
  're-run with `--sdk-path <SDK checkout or packed .tgz>` (see docs/installation.md#installing-from-a-local-build).\n';

/** Providers whose first run needs an API key from the environment (ollama and pi do not). */
const KEYED_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter']);

function nextSteps(dir: string, cwd: string, pm: PackageManager, envKey: string, installed: boolean, keyMissing: boolean): string {
  const relative = path.relative(cwd, dir) || '.';
  const lines = [`cd ${relative.includes(' ') ? JSON.stringify(relative) : relative}`];
  if (!installed) lines.push(`${pm} install`);
  lines.push(`${process.platform === 'win32' ? 'copy' : 'cp'} .env.example .env   # then set ${envKey}`, `${pm} run dev`);
  const keyNote = keyMissing
    ? `\nNo ${envKey} found in your environment, so \`${pm} run dev\` will fail until you set it in .env. \`${pm} run test\` runs offline without a key.\n`
    : '';
  return `\nNext steps:\n${lines.map((line) => `  ${line}`).join('\n')}\n${keyNote}\n(\`${pm} run test\` runs the offline tests; \`${pm} run doctor\` checks your setup.)\n`;
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

  const botFlags = botFlagsUsed(options);
  if (choices.template !== 'telegram' && botFlags.length) {
    throw new InitUsageError(`lousho init: ${botFlags.join(', ')} only work with --template telegram.`);
  }

  const sdkDependency = resolveSdkDependency(environment.sdk.version, dir, options.sdkPath);
  const files = renderProject({
    name: packageNameFor(dir),
    provider: choices.provider,
    template: choices.template as Template,
    packageManager: choices.packageManager,
    sdkDependency,
    sdk: environment.sdk,
    bot: {
      name: options.botName,
      token: options.botToken,
      username: options.botUsername,
      allowedChats: options.allowedChats,
      persona: options.persona,
    },
  });
  environment.write(`Creating ${choices.template} ${choices.provider} agent in ${dir}\n`);
  writeFiles(dir, files);

  const installed = await finish(options, choices, dir, environment);
  const envKey = listProviders().find((info) => info.name === choices.provider)!.envKey;
  const keyMissing = KEYED_PROVIDERS.has(choices.provider) && !environment.env[envKey];
  environment.write(nextSteps(dir, environment.cwd, choices.packageManager, envKey, installed, keyMissing));
  return options.install && !installed ? 1 : 0;
}

/**
 * Entry point behind `lousho init` (and `npm create lousho`). Resolves to
 * the process exit code; usage errors are printed, not thrown.
 */
export async function runInit(argv: string[], environment: InitEnvironment = realInitEnvironment()): Promise<number> {
  let options: InitOptions;
  try {
    options = parseInitArgs(argv, environment.env);
    if (!options.help) validateFlags(options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    environment.writeError(`${error.message}\n`);
    return error instanceof InitUsageError ? USAGE_EXIT_CODE : 1;
  }
  if (options.help) {
    environment.write(`${INIT_USAGE}\n`);
    return 0;
  }
  try {
    return await scaffold(options, environment);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    environment.writeError(`${error.message}\n`);
    return 1;
  }
}
