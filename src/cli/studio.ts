/**
 * `loushy studio` - LOU-N's dev launcher for Agent Forge.
 *
 * Unlike `loushy dev` (a single-process http.Server for chatting with one
 * spec file), `loushy studio` starts TWO things together:
 *
 *   1. The LOU-N runtime control server (`apps/agent-forge/server/index.ts`)
 *      - REST/WS API for running agents (POST /agents/:id/run, stop,
 *        status, approve, WS /agents/:id/stream).
 *   2. `apps/agent-forge`'s own Vite dev server - the visual canvas UI.
 *
 * Both are started as child processes rather than imported in-process,
 * deliberately: `apps/agent-forge` is a separate workspace package (its own
 * `package.json`, its own TypeScript project, `"type": "module"`, its own
 * dependency graph including `express`/`ws`/React/Vite) - importing its
 * server code as a module from this SDK's own CLI bundle (built by tsup
 * into `dist/cli/*.js`) would mean either (a) bundling all of
 * apps/agent-forge/server's dependencies into the SDK's own dist output, or
 * (b) a runtime `require()` reaching across the package boundary into
 * another workspace's source - both worse than just spawning two ordinary
 * `npm`-script child processes and letting each package manage its own
 * dependencies. This keeps `apps/agent-forge/**` genuinely optional for
 * every other SDK consumer: `loushy studio` only works from within this
 * monorepo (or another repo that vendors `apps/agent-forge` the same way),
 * and says so if the app directory isn't found.
 *
 * This is the "in dev mode this can just mean start the Vite dev server +
 * the API server together and print both URLs" option the ticket calls
 * out as sufficient for this epic - a fully bundled single-process
 * production launcher is real future work (LOU-S packaging), not attempted
 * here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export interface StudioOptions {
  /** Repo root containing `apps/agent-forge`. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Port for the LOU-N API server (env `PORT` for the child process). Default 4750. */
  apiPort?: number;
  /** Host for the LOU-N API server. Default 127.0.0.1. */
  apiHost?: string;
}

export interface StudioHandle {
  apiProcess: ChildProcess;
  viteProcess: ChildProcess;
  stop: () => void;
}

function resolveNpmCommand(): string {
  // On Windows, the npm executable is `npm.cmd`; `spawn('npm', ...)` without
  // `shell: true` fails to find it via PATH resolution the way a real shell
  // would. Using the platform-appropriate name avoids needing `shell: true`
  // (which has its own quoting hazards) on any platform.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * Starts the LOU-N API server and the Agent Forge Vite dev server as
 * sibling child processes, both inheriting this process's stdio so their
 * output (including each one's own "listening on ..." line) shows up
 * directly in the terminal that ran `loushy studio`.
 */
export function startStudio(options: StudioOptions = {}): StudioHandle {
  const repoRoot = options.repoRoot ?? process.cwd();
  const appDir = path.join(repoRoot, 'apps', 'agent-forge');

  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(
      `loushy studio: could not find apps/agent-forge under '${repoRoot}'. ` +
        'Run this from the root of a repo that includes the Agent Forge app ' +
        '(this SDK monorepo, or a project that vendors apps/agent-forge the same way).'
    );
  }

  const apiPort = options.apiPort ?? 4750;
  const apiHost = options.apiHost ?? '127.0.0.1';
  const npmCmd = resolveNpmCommand();

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] starting API server (port ${apiPort}) and Vite dev server...`);

  const apiProcess = spawn(npmCmd, ['run', 'server:dev'], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(apiPort), HOST: apiHost, BASE_DIR: repoRoot },
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
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`[loushy studio] API server exited with code ${code}`);
    }
    viteProcess.kill();
  });
  viteProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`[loushy studio] Vite dev server exited with code ${code}`);
    }
    apiProcess.kill();
  });

  // eslint-disable-next-line no-console
  console.log(`[loushy studio] API server:  http://${apiHost}:${apiPort}`);
  // eslint-disable-next-line no-console
  console.log('[loushy studio] Agent Forge UI: see the Vite dev server output above for its URL (default http://localhost:5173)');

  return { apiProcess, viteProcess, stop };
}
