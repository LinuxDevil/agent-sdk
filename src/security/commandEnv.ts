/**
 * The environment a sandboxed or workspace command gets (LOU-X11).
 *
 * Commands a model asks for must not see the host's secrets (API keys,
 * cloud credentials), so they get an allowlisted environment: a small base
 * a shell needs to start, plus names and values the caller opts into.
 * No `node:*` imports: the host env and platform are read from `process`
 * only when no explicit host is passed.
 */

/** Host variables every command gets on every platform: what a shell needs to start. `LC_*` is included too. */
const BASE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'TERM'] as const;
/** Without these, cmd.exe and most Windows programs cannot start. They hold no secrets. */
const WINDOWS_BASE_ENV = ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'WINDIR'] as const;

/** The host a command env is built from; tests pass one to cover both platforms. */
interface CommandHost {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
}

interface CommandEnvOptions {
  /** Values set for every command, on top of anything copied from the host. */
  env?: Readonly<Record<string, string>>;
  /** Extra host variable names to copy, or `true` to pass the whole host environment (opt-out). */
  inheritEnv?: readonly string[] | true;
}

function currentHost(): CommandHost {
  return { env: process.env, platform: process.platform };
}

/** Copies the named host variables (case-insensitively on Windows, like the OS), plus `LC_*` when `locale` is set. */
function pick(host: CommandHost, names: readonly string[], locale: boolean): Record<string, string> {
  const fold = host.platform === 'win32' ? (name: string) => name.toUpperCase() : (name: string) => name;
  const wanted = new Set(names.map(fold));
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(host.env)) {
    if (value !== undefined && (wanted.has(fold(name)) || (locale && name.startsWith('LC_')))) picked[name] = value;
  }
  return picked;
}

/**
 * The environment for a command: the platform base (unless `base: false`,
 * e.g. for a container that brings its own PATH and HOME), the host
 * variables named in `inheritEnv`, then `env`. Nothing else from the host
 * is passed, unless `inheritEnv` is `true`.
 */
export function commandEnv(
  options: CommandEnvOptions = {},
  { base = true, host = currentHost() }: { base?: boolean; host?: CommandHost } = {}
): Record<string, string> {
  if (options.inheritEnv === true) return { ...pick(host, Object.keys(host.env), false), ...options.env };
  const baseNames = base ? [...BASE_ENV, ...(host.platform === 'win32' ? WINDOWS_BASE_ENV : [])] : [];
  return { ...pick(host, [...baseNames, ...(options.inheritEnv ?? [])], base), ...options.env };
}
