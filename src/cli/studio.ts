/**
 * `loushy studio` - launches Agent Forge, the visual dashboard for building,
 * running and debugging agents built with this SDK.
 *
 * Two modes (S1, LOU-S):
 *
 *   - **prod** (single process, single port): the LOU-N runtime control
 *     server (`apps/agent-forge/server`, bundled to plain JS by
 *     `apps/agent-forge/server/tsup.config.ts` into `dist-server/index.cjs`)
 *     serves both its own REST/WS API *and* the pre-built client
 *     (`apps/agent-forge/dist`, `vite build`'s output) as static files - see
 *     `createApp`'s `staticDir` option in `apps/agent-forge/server/app.ts`.
 *     No Vite process, no TypeScript loader (`tsx`), no dev dependencies:
 *     this is what actually ships in the published npm package and what
 *     `loushy studio` runs by default once `apps/agent-forge` has been
 *     built (`build:studio` - see the root `package.json`'s
 *     `prepublishOnly`, which always runs it before `npm publish`).
 *
 *   - **dev** (two sibling processes, LOU-N's original shape): the LOU-N API
 *     server run via `tsx` straight off its TypeScript source, plus
 *     `apps/agent-forge`'s own Vite dev server (HMR) proxying `/agents/**`
 *     to it. Only usable from inside a source checkout that has
 *     `apps/agent-forge/src`/`server` and its devDependencies installed
 *     (this monorepo, or a project vendoring `apps/agent-forge` the same
 *     way) - not something the published package can rely on, which is
 *     exactly why prod mode above exists.
 *
 * Mode selection: `--prod` / `--dev` force one or the other (and error
 * clearly if what they need isn't present); with neither flag, `loushy
 * studio` auto-detects by checking whether `apps/agent-forge/dist-server`
 * has already been built - present (the normal case for anyone who `npm
 * install`ed the published package) means prod, absent (the normal case
 * mid-development in this monorepo, before running `build:studio`) means
 * dev. This means the *same* `loushy studio` command is the right one to
 * document for both audiences; only what's on disk differs.
 *
 * Both modes are still started as child process(es) rather than imported
 * in-process, deliberately: `apps/agent-forge` is a separate workspace
 * package (its own `package.json`, `"type": "module"`, its own dependency
 * graph) - importing its code as a module from this SDK's own CLI bundle
 * would mean bundling all of `apps/agent-forge`'s dependencies into the
 * SDK's own `dist/`. Spawning `node dist-server/index.cjs` (prod) or two
 * ordinary `npm`-script child processes (dev) keeps `apps/agent-forge/**`
 * genuinely optional for every other SDK consumer, and says so clearly if
 * the app directory (or its build output, in `--prod`) isn't found.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export type StudioMode = 'auto' | 'dev' | 'prod';

export interface StudioOptions {
  /** Repo root containing `apps/agent-forge`. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Port for the LOU-N API server (env `PORT` for the child process). Default 4750. */
  apiPort?: number;
  /** Host for the LOU-N API server. Default 127.0.0.1. */
  apiHost?: string;
  /**
   * 'prod' | 'dev' force a mode (and throw if what it needs isn't present);
   * 'auto' (default) picks 'prod' when `apps/agent-forge/dist-server` has
   * been built, else 'dev'.
   */
  mode?: StudioMode;
}

export interface StudioHandle {
  /** The LOU-N API server (prod: also serves the UI). Always present. */
  apiProcess: ChildProcess;
  /** The Vite dev server. Only present in dev mode. */
  viteProcess?: ChildProcess;
  mode: 'dev' | 'prod';
  stop: () => void;
}

function resolveNpmCommand(): string {
  // On Windows, the npm executable is `npm.cmd`; `spawn('npm', ...)` without
  // `shell: true` fails to find it via PATH resolution the way a real shell
  // would. Using the platform-appropriate name avoids needing `shell: true`
  // (which has its own quoting hazards) on any platform.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function distServerEntry(appDir: string): string {
  // `.cjs`, not `.js` - see `apps/agent-forge/server/tsup.config.ts`'s doc
  // comment for why the server is bundled to CommonJS.
  return path.join(appDir, 'dist-server', 'index.cjs');
}

function resolveMode(appDir: string, requested: StudioMode): 'dev' | 'prod' {
  if (requested === 'dev' || requested === 'prod') return requested;
  return fs.existsSync(distServerEntry(appDir)) ? 'prod' : 'dev';
}

/**
 * Starts Agent Forge: in prod mode, a single LOU-N API server process that
 * also serves the pre-built UI; in dev mode, that same API server (run from
 * TS source via `tsx`) alongside a sibling Vite dev server process. Both
 * inherit this process's stdio so their output (including each one's own
 * "listening on ..." line) shows up directly in the terminal that ran
 * `loushy studio`.
 */
export function startStudio(options: StudioOptions = {}): StudioHandle {
  const { repoRoot = process.cwd(), apiPort = 4750, apiHost = '127.0.0.1', mode: requested = 'auto' } = options;
  const appDir = path.join(repoRoot, 'apps', 'agent-forge');

  assertAgentForgeApp(appDir, repoRoot);

  const mode = resolveMode(appDir, requested);

  if (mode === 'prod') return startProdStudio(appDir, repoRoot, apiPort, apiHost);
  return startDevStudio(appDir, repoRoot, apiPort, apiHost);
}

function assertAgentForgeApp(appDir: string, repoRoot: string): void {
  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(
      `loushy studio: could not find apps/agent-forge under '${repoRoot}'. ` +
        'Run this from the root of a repo that includes the Agent Forge app ' +
        '(this SDK monorepo, or a project that vendors apps/agent-forge the same way).'
    );
  }
}

/** Logs a child process's non-zero exit (a null code means it was killed by a signal). */
function reportUnexpectedExit(label: string, code: number | null): void {
  if (code !== 0 && code !== null) {
    // eslint-disable-next-line no-console
    console.error(`[loushy studio] ${label} exited with code ${code}`);
  }
}

function assertProdBuildPresent(appDir: string, entry: string): void {
  if (!fs.existsSync(entry)) {
    throw new Error(
      `loushy studio --prod: '${entry}' does not exist. Build Agent Forge first: ` +
        "run 'npm run build:studio' from the repo root (this bundles both the client " +
        "'vite build' output into apps/agent-forge/dist and the server into " +
        'apps/agent-forge/dist-server).'
    );
  }
  const clientIndex = path.join(appDir, 'dist', 'index.html');
  if (!fs.existsSync(clientIndex)) {
    // eslint-disable-next-line no-console
    console.error(
      `[loushy studio] warning: '${clientIndex}' not found - the API will run, but no UI will ` +
        "be served. Run 'npm run build:studio' from the repo root to build the client too."
    );
  }
}

function startProdStudio(appDir: string, repoRoot: string, apiPort: number, apiHost: string): StudioHandle {
  const entry = distServerEntry(appDir);
  assertProdBuildPresent(appDir, entry);

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] starting production server (port ${apiPort})...`);

  const apiProcess = spawn(process.execPath, [entry], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(apiPort), HOST: apiHost, BASE_DIR: repoRoot },
  });

  function stop(): void {
    apiProcess.kill();
  }

  apiProcess.on('exit', (code) => reportUnexpectedExit('server', code));

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] Agent Forge: http://${apiHost}:${apiPort}`);

  return { apiProcess, mode: 'prod', stop };
}

function assertDevSourcePresent(appDir: string): void {
  if (!fs.existsSync(path.join(appDir, 'server', 'index.ts'))) {
    throw new Error(
      `loushy studio --dev: '${path.join(appDir, 'server', 'index.ts')}' does not exist - dev mode ` +
        'needs the Agent Forge TypeScript source (this only works from inside the SDK monorepo, ' +
        "not from an installed npm package). Use the default/--prod mode instead, after running " +
        "'npm run build:studio'."
    );
  }
}

function startDevStudio(appDir: string, repoRoot: string, apiPort: number, apiHost: string): StudioHandle {
  assertDevSourcePresent(appDir);
  const npmCmd = resolveNpmCommand();

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] starting API server (port ${apiPort}) and Vite dev server...`);

  const apiProcess = spawn(npmCmd, ['run', 'server:dev'], {
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
    },
  });

  const viteProcess = spawn(npmCmd, ['run', 'dev'], {
    cwd: appDir,
    stdio: 'inherit',
    // Tells vite.config.ts's dev-server proxy where the API server it just
    // spawned above is actually listening (apiHost/apiPort may differ from
    // the server's own defaults if the caller overrode them).
    env: { ...process.env, LOUSHY_STUDIO_API_URL: `http://${apiHost}:${apiPort}` },
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

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] API server:  http://${apiHost}:${apiPort}`);
  // eslint-disable-next-line no-console
  console.log('[loushy studio] Agent Forge UI: see the Vite dev server output above for its URL (default http://localhost:5173)');

  return { apiProcess, viteProcess, mode: 'dev', stop };
}
