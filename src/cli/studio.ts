/**
 * `lousho studio` - opens Lousho Studio, the visual dashboard for building,
 * running and debugging agents built with this SDK.
 *
 * Studio is a separate package (`@linuxdevil/studio`, W13a/W13b): the SDK
 * tarball no longer ships `apps/agent-forge`, so this command resolves a
 * Studio install and launches its CLI (`dist-server/cli.cjs`) as a child
 * process. Two kinds of target:
 *
 *   - **checkout**: `<cwd>/apps/agent-forge` whose package.json is named
 *     `@linuxdevil/studio` - i.e. this SDK repository. Keeps the
 *     contributor modes:
 *
 *       - **prod**: `dist-server/cli.cjs --workspace <cwd> --port <p>
 *         --host <h>` - one process serving the built UI and API (the
 *         Studio CLI mints and prints its own per-launch token).
 *       - **dev**: the API server via `tsx` plus the Vite dev server
 *         (HMR), exactly as before; only meaningful with the app's
 *         devDependencies installed.
 *
 *   - **installed**: `@linuxdevil/studio` resolved from the current
 *     directory's node_modules, then next to the SDK package, then npm's
 *     global root. Launched the same way as prod (`cli.cjs` with
 *     `--workspace <cwd>`); `--prod`/`--dev` are a usage error there.
 *
 * With no Studio anywhere the command prints STUDIO_MISSING and exits 1.
 * Spawning a child process (rather than importing the app) is deliberate:
 * Studio's dependency graph stays out of the SDK's own CLI bundle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { exitCodeFor, parseCommand, portValue, stringValue, usageError, type CommandSpec } from './args';
import { ConfigurationError } from '../execution/errors';
import { findSdkRoot } from '../deploy/bundle';

/** The published Studio package `lousho studio` looks for. */
export const STUDIO_PACKAGE = '@linuxdevil/studio';
/** Printed when no Studio checkout or install can be found. */
export const STUDIO_MISSING = `Studio is a separate install: npx ${STUDIO_PACKAGE}`;

export type StudioMode = 'auto' | 'dev' | 'prod';

export type StudioTarget =
  /** `<cwd>/apps/agent-forge` in the SDK repository. */
  | { kind: 'checkout'; appDir: string }
  /** An installed `@linuxdevil/studio` package. */
  | { kind: 'installed'; cliPath: string; packageDir: string };

export interface FindStudioOptions {
  /** Root of the installed SDK package (step 3 of the search). Defaults to findSdkRoot(). */
  packageRoot?: string;
  /** npm's global root (`npm root -g`). Injectable for tests. */
  globalRoot?: () => string | undefined;
}

export interface StudioOptions {
  /** Directory `lousho studio` was run from: the checkout lookup root and the installed `--workspace`. Default process.cwd(). */
  repoRoot?: string;
  /** Port for the studio server. Default 4750. */
  apiPort?: number;
  /** Host for the studio server. Default 127.0.0.1. */
  apiHost?: string;
  /**
   * 'prod' | 'dev' force a checkout mode (and throw if what they need isn't
   * present); 'auto' (default) picks 'prod' when the checkout's
   * `dist-server/cli.cjs` has been built, else 'dev'. With an installed
   * target any explicit mode is a usage error.
   */
  mode?: StudioMode;
  /** Forwarded to {@link findStudio}. */
  packageRoot?: string;
  /** Forwarded to {@link findStudio}. */
  globalRoot?: () => string | undefined;
  /** Test seam replacing `node:child_process`'s spawn for the launched Studio. */
  spawnFn?: typeof spawn;
}

/**
 * Env var carrying the per-launch API token to the studio server in dev
 * mode (and to Vite's proxy). Mirrors `STUDIO_TOKEN_ENV` in
 * `apps/agent-forge/server/auth.ts`.
 */
const STUDIO_TOKEN_ENV = 'LOUSHO_STUDIO_TOKEN';
/** Extra origins the API accepts - in dev mode, the Vite dev server's (vite.config.ts pins port 5173). */
const STUDIO_ALLOWED_ORIGINS_ENV = 'LOUSHO_STUDIO_ALLOWED_ORIGINS';
const VITE_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** The URL to open: the studio's origin plus the per-launch token. */
export function studioUrl(apiHost: string, apiPort: number, token: string): string {
  const host = apiHost === '0.0.0.0' || apiHost === '::' ? '127.0.0.1' : apiHost.includes(':') ? `[${apiHost}]` : apiHost;
  return `http://${host}:${apiPort}/?token=${encodeURIComponent(token)}`;
}

export interface StudioHandle {
  /**
   * The per-launch token every API/WebSocket request must carry. Only known
   * in checkout dev mode - prod and installed launches let the Studio CLI
   * mint and print its own.
   */
  token?: string;
  /** The studio server process (dev mode: the API server; viteProcess is the UI). */
  apiProcess: ChildProcess;
  /** The Vite dev server. Only present in checkout dev mode. */
  viteProcess?: ChildProcess;
  mode: 'dev' | 'prod' | 'installed';
  stop: () => void;
}

function resolveNpmCommand(): string {
  // On Windows, the npm executable is `npm.cmd`; `spawn('npm', ...)` without
  // `shell: true` fails to find it via PATH resolution the way a real shell
  // would. Using the platform-appropriate name avoids needing `shell: true`
  // (which has its own quoting hazards) on any platform.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function studioCliEntry(appDir: string): string {
  // `.cjs`, not `.js` - see `apps/agent-forge/server/tsup.config.ts`'s doc
  // comment for why the server is bundled to CommonJS.
  return path.join(appDir, 'dist-server', 'cli.cjs');
}

/** True when `dir/apps/agent-forge/package.json` names the Studio package (the SDK checkout). */
function isStudioCheckout(dir: string): boolean {
  const pkgPath = path.join(dir, 'apps', 'agent-forge', 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name === STUDIO_PACKAGE;
  } catch {
    return false;
  }
}

/** Step 1: the SDK checkout's own `apps/agent-forge`. */
function checkoutTarget(cwd: string): StudioTarget | undefined {
  return isStudioCheckout(cwd) ? { kind: 'checkout', appDir: path.join(cwd, 'apps', 'agent-forge') } : undefined;
}

/** The directory holding `@linuxdevil/studio`'s package.json as resolved from `fromDir`, if any. */
function resolveStudioPackageDir(fromDir: string): string | undefined {
  try {
    const require = createRequire(path.join(fromDir, 'package.json'));
    return path.dirname(require.resolve(`${STUDIO_PACKAGE}/package.json`));
  } catch {
    return undefined;
  }
}

/** An installed target, or undefined when `packageDir` lacks the runnable CLI. */
function installedTarget(packageDir: string | undefined): StudioTarget | undefined {
  if (!packageDir) return undefined;
  const cliPath = path.join(packageDir, 'dist-server', 'cli.cjs');
  if (!fs.existsSync(path.join(packageDir, 'package.json')) || !fs.existsSync(cliPath)) return undefined;
  return { kind: 'installed', cliPath, packageDir };
}

/** Steps 2+3: Studio installed next to `cwd`, then next to the SDK package. */
function localStudioTarget(cwd: string, packageRoot: string | undefined): StudioTarget | undefined {
  for (const dir of [cwd, packageRoot]) {
    const target = dir ? installedTarget(resolveStudioPackageDir(dir)) : undefined;
    if (target) return target;
  }
  return undefined;
}

function sdkRootSafe(): string | undefined {
  try {
    return findSdkRoot();
  } catch {
    return undefined;
  }
}

/** npm's global root (`npm root -g`); undefined when npm cannot answer. */
function defaultGlobalRoot(): string | undefined {
  const res = spawnSync(resolveNpmCommand(), ['root', '-g'], { encoding: 'utf8' });
  const root = res.status === 0 ? res.stdout.trim() : '';
  return root || undefined;
}

/** Step 4: Studio installed globally (`npm i -g @linuxdevil/studio`). */
function globalStudioTarget(globalRoot: () => string | undefined): StudioTarget | undefined {
  const root = globalRoot();
  return root ? installedTarget(path.join(root, STUDIO_PACKAGE)) : undefined;
}

/**
 * Finds Studio: the checkout copy under `cwd` first, then an installed
 * `@linuxdevil/studio` resolved from `cwd`, from the SDK package, then npm's
 * global root. Returns undefined when nothing runnable exists.
 */
export function findStudio(cwd: string, options: FindStudioOptions = {}): StudioTarget | undefined {
  return (
    checkoutTarget(cwd) ??
    localStudioTarget(cwd, options.packageRoot ?? sdkRootSafe()) ??
    globalStudioTarget(options.globalRoot ?? defaultGlobalRoot)
  );
}

function resolveMode(appDir: string, requested: StudioMode): 'dev' | 'prod' {
  if (requested === 'dev' || requested === 'prod') return requested;
  if (fs.existsSync(studioCliEntry(appDir))) return 'prod';
  if (!fs.existsSync(path.join(appDir, 'server', 'index.ts'))) {
    // Neither the build nor the source: a checkout packed without a Studio build.
    throw new ConfigurationError(
      `lousho studio: this checkout's Studio has no build ('${studioCliEntry(appDir)}' is missing). ` +
        "Run 'npm run build:studio' from the repo root first.",
      'studio'
    );
  }
  return 'dev';
}

/**
 * Launches Studio: a checkout's prod/dev modes, or an installed package's
 * `cli.cjs`. Child processes inherit this process's stdio so their output
 * shows up in the terminal that ran `lousho studio`.
 */
export function startStudio(options: StudioOptions = {}): StudioHandle {
  const { repoRoot = process.cwd(), apiPort = 4750, apiHost = '127.0.0.1', mode: requested = 'auto' } = options;
  const spawnImpl = options.spawnFn ?? spawn;
  const target = findStudio(repoRoot, options);

  if (!target) throw new ConfigurationError(STUDIO_MISSING, 'studio');
  if (target.kind === 'installed') {
    if (requested !== 'auto') {
      throw usageError(SPEC, '--prod and --dev only apply inside the SDK repository (apps/agent-forge).');
    }
    return startInstalledStudio(target, repoRoot, apiPort, apiHost, spawnImpl);
  }

  const mode = resolveMode(target.appDir, requested);
  if (mode === 'prod') return startProdStudio(target.appDir, repoRoot, apiPort, apiHost, spawnImpl);
  const token = randomBytes(24).toString('base64url');
  return startDevStudio(target.appDir, repoRoot, apiPort, apiHost, token, spawnImpl);
}

/** Logs a child process's non-zero exit (a null code means it was killed by a signal). */
function reportUnexpectedExit(label: string, code: number | null): void {
  if (code !== 0 && code !== null) {
    console.error(`[lousho studio] ${label} exited with code ${code}`);
  }
}

/** Launches an installed Studio: `cli.cjs --workspace <cwd> --port <p> --host <h>`. */
function startInstalledStudio(
  target: Extract<StudioTarget, { kind: 'installed' }>,
  workspace: string,
  apiPort: number,
  apiHost: string,
  spawnImpl: typeof spawn
): StudioHandle {
  console.log(`[lousho studio] starting ${STUDIO_PACKAGE} (port ${apiPort})...`);
  const apiProcess = spawnImpl(
    process.execPath,
    [target.cliPath, '--workspace', workspace, '--port', String(apiPort), '--host', apiHost],
    { stdio: 'inherit' }
  );
  apiProcess.on('exit', (code) => reportUnexpectedExit('Studio', code));
  return { apiProcess, mode: 'installed', stop: () => apiProcess.kill() };
}

function assertProdBuildPresent(appDir: string, entry: string): void {
  if (!fs.existsSync(entry)) {
    throw new ConfigurationError(
      `lousho studio --prod: '${entry}' does not exist. Build Studio first: ` +
        "run 'npm run build:studio' from the repo root (this bundles both the client " +
        "'vite build' output into apps/agent-forge/dist and the server into " +
        'apps/agent-forge/dist-server).', 'studio');
  }
  const clientIndex = path.join(appDir, 'dist', 'index.html');
  if (!fs.existsSync(clientIndex)) {
    console.error(
      `[lousho studio] warning: '${clientIndex}' not found - the API will run, but no UI will ` +
        "be served. Run 'npm run build:studio' from the repo root to build the client too."
    );
  }
}

function startProdStudio(
  appDir: string,
  repoRoot: string,
  apiPort: number,
  apiHost: string,
  spawnImpl: typeof spawn
): StudioHandle {
  const entry = studioCliEntry(appDir);
  assertProdBuildPresent(appDir, entry);

  console.log(`[lousho studio] starting production server (port ${apiPort})...`);

  // cli.cjs mints and prints its own per-launch token; no BASE_DIR/token env.
  const apiProcess = spawnImpl(
    process.execPath,
    [entry, '--workspace', repoRoot, '--port', String(apiPort), '--host', apiHost],
    { cwd: appDir, stdio: 'inherit' }
  );

  function stop(): void {
    apiProcess.kill();
  }

  apiProcess.on('exit', (code) => reportUnexpectedExit('server', code));

  return { apiProcess, mode: 'prod', stop };
}

function assertDevSourcePresent(appDir: string): void {
  if (!fs.existsSync(path.join(appDir, 'server', 'index.ts'))) {
    throw new ConfigurationError(
      `lousho studio --dev: '${path.join(appDir, 'server', 'index.ts')}' does not exist - dev mode ` +
        'needs the Studio TypeScript source (this only works inside the SDK repository, ' +
        "not from an installed npm package). Use the default/--prod mode instead, after running " +
        "'npm run build:studio'.", 'studio');
  }
}

function startDevStudio(
  appDir: string,
  repoRoot: string,
  apiPort: number,
  apiHost: string,
  token: string,
  spawnImpl: typeof spawn
): StudioHandle {
  assertDevSourcePresent(appDir);
  const npmCmd = resolveNpmCommand();

  console.log(`[lousho studio] starting API server (port ${apiPort}) and Vite dev server...`);

  const apiProcess = spawnImpl(npmCmd, ['run', 'server:dev'], {
    cwd: appDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(apiPort),
      HOST: apiHost,
      BASE_DIR: repoRoot,
      // The dev API server never serves the UI itself - Vite (below) does,
      // with HMR - even if a stale apps/agent-forge/dist build happens to
      // exist on disk from a previous `build:studio` run.
      NO_STATIC: '1',
      [STUDIO_TOKEN_ENV]: token,
      // The browser's Origin is Vite's, proxied through to this server.
      [STUDIO_ALLOWED_ORIGINS_ENV]: VITE_DEV_ORIGINS.join(','),
    },
  });

  const viteProcess = spawnImpl(npmCmd, ['run', 'dev'], {
    cwd: appDir,
    stdio: 'inherit',
    // Tells vite.config.ts's dev-server proxy where the API server it just
    // spawned above is actually listening (apiHost/apiPort may differ from
    // the server's own defaults if the caller overrode them).
    env: { ...process.env, LOUSHO_STUDIO_API_URL: `http://${apiHost}:${apiPort}` },
  });

  function stop(): void {
    apiProcess.kill();
    viteProcess.kill();
  }

  // If either child dies unexpectedly, bring the other down too rather than
  // leaving a half-running studio (a UI with no API, or an API with no UI)
  // silently orphaned.
  apiProcess.on('exit', (code) => {
    reportUnexpectedExit('API server', code);
    viteProcess.kill();
  });
  viteProcess.on('exit', (code) => {
    reportUnexpectedExit('Vite dev server', code);
    apiProcess.kill();
  });

  console.log(`[lousho studio] API server:  http://${apiHost}:${apiPort}`);
  console.log(`[lousho studio] Studio UI: ${VITE_DEV_ORIGINS[0]}/?token=${encodeURIComponent(token)}`);

  return { apiProcess, viteProcess, mode: 'dev', token, stop };
}

const USAGE = 'Usage: lousho studio [--port N] [--host H]';

const HELP = `${USAGE}

Opens Lousho Studio on this project. Studio is a separate package: install it with npm i -g @linuxdevil/studio
(or run npx @linuxdevil/studio). This command finds it and opens this folder as a workspace.

Options:
  --port N    the studio's port (default 4750)
  --host H    the interface to listen on (default 127.0.0.1)
  --prod      (SDK repository only) serve the built UI from one process
  --dev       (SDK repository only) run the API and the Vite dev server
  -h, --help  show this help`;

const SPEC: CommandSpec = {
  command: 'studio',
  usage: USAGE,
  options: { port: { type: 'string' }, host: { type: 'string' }, prod: { type: 'boolean' }, dev: { type: 'boolean' } },
};

/** Parses the arguments after `studio`; `--prod` with `--dev` is `LOUSHO_CONFIG_INVALID`. */
export function parseStudioArgs(rest: string[]): StudioOptions & { help?: boolean } {
  const { values, help } = parseCommand(SPEC, rest);
  if (values.prod && values.dev) throw usageError(SPEC, '--prod and --dev cannot be combined.');
  const mode: StudioMode = values.prod ? 'prod' : values.dev ? 'dev' : 'auto';
  return { apiPort: portValue(SPEC, values.port, 4750), apiHost: stringValue(values.host) ?? '127.0.0.1', mode, help: help || undefined };
}

/** Runs `lousho studio` with the arguments after `studio`; resolves with the exit code (the children keep the process alive). */
export async function runStudio(rest: string[]): Promise<number> {
  try {
    const { help, ...options } = parseStudioArgs(rest);
    if (help) {
      console.log(HELP);
      return 0;
    }
    startStudio({ ...options, repoRoot: process.cwd() });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return exitCodeFor(error);
  }
}
