/**
 * Flag parsing and value validation for `lousho init`.
 */
import { parseArgs } from 'node:util';
import { listProviders } from '../../providers/providerSpec';

export const TEMPLATES = ['minimal', 'tools', 'yaml'] as const;
export type Template = (typeof TEMPLATES)[number];

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Provider names `--provider` accepts (openai, anthropic, openrouter, ollama). */
export const PROVIDER_NAMES: readonly string[] = listProviders().map((info) => info.name);

export const INIT_USAGE = `Usage: lousho init [dir] [options]

Scaffold a runnable @lousho/build-ai-agent project in one command.

Options:
  --provider <name>         ${PROVIDER_NAMES.join(' | ')}  (default: detected from your API key env var, else openai)
  --template <name>         ${TEMPLATES.join(' | ')}  (default: minimal)
  --package-manager <name>  ${PACKAGE_MANAGERS.join(' | ')}  (default: detected from how you ran this, else npm)
  --yes, -y                 Do not prompt; use defaults for anything not given as a flag
  --no-install              Do not install dependencies
  --no-git                  Do not run git init
  --force                   Write into a directory even if it is not empty
  --sdk-path <dir|tarball>  Local development: depend on a checkout or packed .tgz of the SDK
                            instead of the published version (env: LOUSHO_SDK_PATH).
                            See docs/installation.md#installing-from-a-local-build
  --help, -h                Show this help`;

export interface InitOptions {
  help: boolean;
  dir?: string;
  provider?: string;
  template?: string;
  packageManager?: string;
  yes: boolean;
  install: boolean;
  git: boolean;
  force: boolean;
  sdkPath?: string;
}

/** Thrown for any bad flag or value; the message is printed as-is. */
export class InitUsageError extends Error {}

/** Parses `lousho init` argv. Unknown flags and extra positionals are errors. */
export function parseInitArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): InitOptions {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        yes: { type: 'boolean', short: 'y' },
        force: { type: 'boolean' },
        'no-install': { type: 'boolean' },
        'no-git': { type: 'boolean' },
        provider: { type: 'string' },
        template: { type: 'string' },
        'package-manager': { type: 'string' },
        'sdk-path': { type: 'string' },
      },
    });
  } catch (error) {
    throw new InitUsageError(`lousho init: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new InitUsageError(`lousho init: expected at most one directory, got ${positionals.length}: ${positionals.join(' ')}`);
  }
  return {
    help: values.help === true,
    dir: positionals[0],
    provider: values.provider as string | undefined,
    template: values.template as string | undefined,
    packageManager: values['package-manager'] as string | undefined,
    yes: values.yes === true,
    install: values['no-install'] !== true,
    git: values['no-git'] !== true,
    force: values.force === true,
    sdkPath: (values['sdk-path'] as string | undefined) ?? (env.LOUSHO_SDK_PATH || undefined),
  };
}

/** Returns `value` if it is one of `allowed`, otherwise throws naming the flag and the allowed set. */
export function expectOneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InitUsageError(`lousho init: invalid ${flag} '${value}'. Allowed values: ${allowed.join(', ')}.`);
}

/**
 * The package manager that launched this process, read from
 * `npm_config_user_agent` (e.g. `pnpm/9.1.0 npm/? node/v22.0.0 linux x64`);
 * `npm` when unset or unrecognised.
 */
export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const name = (env.npm_config_user_agent ?? '').split('/')[0];
  return (PACKAGE_MANAGERS as readonly string[]).includes(name) ? (name as PackageManager) : 'npm';
}
