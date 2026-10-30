/**
 * Runtime control server entry point.
 *
 * Started either directly (`tsx server/index.ts`, e.g. from `lousho studio`
 * - see src/cli/studio.ts) or programmatically via `startStudioServer()`
 * for tests/embedding.
 */
import { once } from 'node:events';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app';
import { attachWebSocketServer } from './wsServer';
import { RunManager } from './runRegistry';
import { SecretsStore } from './secretsStore';
import { SettingsStore } from './settingsStore';
import { startJudgeLoop, type JudgeLoopOptions } from './judge';
import { STUDIO_ALLOWED_ORIGINS_ENV, STUDIO_TOKEN_ENV, allowedHostsFor, mintStudioToken } from './auth';
import { createWorkspaceContext } from './workspace/context';
import { configureStudioHome, studioPaths } from './workspace/studioPaths';
import { workspaceRefFor } from './workspace/workspaceId';

export interface StudioServerHandle {
  server: http.Server;
  port: number;
  runManager: RunManager;
  /** The per-launch token every API/WebSocket request must carry. */
  token: string;
  /** The URL to open: the studio's own origin with `?token=` appended. */
  url: string;
  close: () => Promise<void>;
}

export interface StartStudioServerOptions {
  /** Directory `.lousho/agents/**` is read from/written to. Defaults to process.cwd(). */
  baseDir?: string;
  port?: number;
  host?: string;
  /**
   * Directory holding the built client (`vite build`'s output,
   * `apps/agent-forge/dist`) to serve as static files - see
   * `createApp`'s `staticDir` doc comment in `./app.ts`. Defaults to
   * `<this file's directory>/../dist`, i.e. `apps/agent-forge/dist`
   * alongside this server, which is where both `apps/agent-forge`'s own
   * `npm run build` and the SDK's `build:studio` script put it. Pass
   * `false` to explicitly disable static serving (dev mode, where Vite
   * itself serves the UI).
   */
  staticDir?: string | false;
  /**
   * The per-launch API token. Defaults to the
   * `LOUSHO_STUDIO_TOKEN` env var (set by `lousho studio`), else a freshly
   * minted random one.
   */
  token?: string;
  /**
   * Report builder runs to the observe daemon (`LOUSHO_OBSERVE_URL`, see
   * server/observeReporting.ts) so the top bar's "Open trace" resolves.
   * Defaults to true; pass `false` to make no reporter (an embedding or a
   * test that must not reach a daemon).
   */
  observe?: boolean;
  /**
   * The LLM-judge loop (judge.ts) that pulls judge-evaluator jobs from the
   * observe daemon and runs them with this server's provider keys. On by
   * default unless `observe` is `false`; `false` turns it off, an object
   * overrides its options (`intervalMs`, `leaseMs`, `judgeTimeoutMs`,
   * `fetch`, `judge`, `warn`). Launched directly, `LOUSHO_STUDIO_JUDGE=0`
   * turns it off (the e2e server does).
   */
  judge?: false | Partial<Omit<JudgeLoopOptions, 'secretsStore'>>;
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  server.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`[lousho studio] API server port ${port} is already in use.`);
    }
    throw err;
  }
}

/** `false` disables static serving; `undefined` defaults to the pre-built client next to the server. */
function resolveStaticDir(staticDir: string | false | undefined, moduleDir: string): string | undefined {
  if (staticDir === false) return undefined;
  return staticDir ?? path.join(moduleDir, '..', 'dist');
}

export async function startStudioServer(
  options: StartStudioServerOptions = {}
): Promise<StudioServerHandle> {
  const baseDir = options.baseDir ?? process.cwd();
  const port = options.port ?? 4750;
  const host = options.host ?? '127.0.0.1';
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = resolveStaticDir(options.staticDir, moduleDir);

  // The Studio home keeps every file where it was (the launch folder's
  // `.lousho/`); moving it to `~/.lousho/studio` is a later change of this
  // one default - every store below already reads its paths from it.
  configureStudioHome(path.join(baseDir, '.lousho'));
  const paths = studioPaths();
  const secretsStore = new SecretsStore(paths);
  const settingsStore = new SettingsStore(paths);

  const workspace = createWorkspaceContext(workspaceRefFor(baseDir), {
    secretsStore,
    settingsStore,
    observe: options.observe !== false,
  });

  const token = options.token ?? (process.env[STUDIO_TOKEN_ENV] || mintStudioToken());
  const allowedOrigins = (process.env[STUDIO_ALLOWED_ORIGINS_ENV] ?? '').split(',').filter(Boolean);
  const access = { token, allowedHosts: allowedHostsFor(host), allowedOrigins };
  const app = createApp({ workspace, baseDir, studioHome: paths.home, secretsStore, settingsStore, staticDir, access });
  const server = http.createServer(app);
  attachWebSocketServer(server, workspace.runs, access);

  await listen(server, port, host);
  const judgeOption = options.judge ?? (options.observe === false ? false : {});
  const judgeLoop = judgeOption === false ? undefined : startJudgeLoop({ ...judgeOption, secretsStore });
  const boundPort = (server.address() as { port: number }).port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  return {
    server,
    port: boundPort,
    runManager: workspace.runs,
    token,
    url: `http://${urlHost}:${boundPort}/?token=${encodeURIComponent(token)}`,
    close: () => {
      judgeLoop?.stop();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// Allow `tsx server/index.ts` (or `node --import tsx server/index.ts`) to
// boot the server directly, reading PORT/HOST/BASE_DIR from the
// environment - this is how `lousho studio` (src/cli/studio.ts) launches it
// as a child process. `apps/agent-forge/package.json` has `"type": "module"`,
// so this module runs as real ESM under tsx - there is no CJS `require`/
// `module` to compare against, hence the `import.meta.url` check instead of
// the usual `require.main === module` idiom.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const host = process.env.HOST;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // moduleDir is apps/agent-forge/server - the repo root (where `.lousho/`
  // should live) is three levels up, unless BASE_DIR is set explicitly.
  const baseDir = process.env.BASE_DIR ?? path.resolve(moduleDir, '..', '..', '..');
  // `src/cli/studio.ts` sets NO_STATIC=1 in dev mode (separate Vite dev
  // server process serves the UI there) and STATIC_DIR to override the
  // default `apps/agent-forge/dist` lookup in prod mode.
  const staticDir = process.env.NO_STATIC ? false : (process.env.STATIC_DIR ?? undefined);

  const judge = process.env.LOUSHO_STUDIO_JUDGE === '0' ? false : undefined;
  startStudioServer({ port, host, baseDir, staticDir, judge })
    .then((handle) => {
      console.log(`[lousho studio] API server listening on http://${host ?? '127.0.0.1'}:${handle.port}`);
      // `lousho studio` mints the token itself and prints this URL; only print it when launched directly.
      if (!process.env[STUDIO_TOKEN_ENV]) console.log(`[lousho studio] Agent Forge: ${handle.url}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
