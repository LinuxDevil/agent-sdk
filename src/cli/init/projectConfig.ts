/**
 * The shared init-project contract: the shape `renderProject` consumes and the
 * provider resolver both `templates.ts` and `telegramTemplate.ts` need. Kept in
 * its own module so template files stay acyclic (telegramTemplate -> here,
 * templates -> telegramTemplate).
 */
import { listProviders } from '../../providers/providerSpec';
import { ConfigurationError } from '../../execution/errors';
import type { PackageManager, Template } from './options';
import type { SdkManifest } from './sdkDependency';

/** Bot options collected from `--bot-*`/`--persona` flags. */
export interface BotOptions {
  name?: string;
  token?: string;
  username?: string;
  allowedChats?: string;
  persona?: string;
}

export interface ProjectConfig {
  /** npm package name (also the directory's base name). */
  name: string;
  provider: string;
  template: Template;
  packageManager: PackageManager;
  /** `dependencies["@lousho/build-ai-agent"]`: a range, or `file:./<tarball>`. */
  sdkDependency: string;
  sdk: SdkManifest;
  /** Telegram template only: --bot-* / --persona flag values baked into .env and the persona. */
  bot?: BotOptions;
}

export function providerInfo(provider: string) {
  const info = listProviders().find((candidate) => candidate.name === provider);
  if (!info) throw new ConfigurationError(`lousho init: unknown provider '${provider}'.`, 'provider', 'LOUSHO_PROVIDER_UNKNOWN');
  return info;
}
