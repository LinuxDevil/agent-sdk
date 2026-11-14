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
import { attachEventsWebSocket } from './events/eventsWs';
import { createUpgradeRouter, type UpgradeRouter } from './ws/upgradeRouter';
import { RunManager } from './runRegistry';
import { SecretsStore } from './secretsStore';
import { SettingsStore } from './settingsStore';
import { startJudgeLoop, type JudgeLoopOptions } from './judge';
import type { IdleVersioner } from './storage/idleVersioner';
import { STUDIO_ALLOWED_ORIGINS_ENV, STUDIO_TOKEN_ENV, allowedHostsFor, mintStudioToken } from './auth';
import { createWorkspaceContext, type WorkspaceServices } from './workspace/context';
import { WorkspaceManager } from './workspace/workspaceManager';
import { configureStudioHome, studioPaths } from './workspace/studioPaths';
import { WorkspaceRegistry } from './workspace/workspaceRegistry';
import { AUTHOR_STREAM_PATH } from '../shared/authorWire';
import { AuthorSessionStore } from './author/sessionStore';
import { createAuthorUpgradeHandler } from './author/authorStream';
import { AuthorTurnRunner } from './author/turnRunner';
import { createAuthorRunner } from './author/wiring';
import { TemplateCatalog } from './templates/templateCatalog';
import { PassRunner } from './passes/passRunner';
import { SpendLog } from './passes/spendLog';
import { AlertStore } from './inbox/alertStore';

export interface StudioServerHandle {
  server: http.Server;
  port: number;
  runManager: RunManager;
  /**
   * The server's one WS upgrade router (ws/upgradeRouter.ts): `/agents/:id/stream`
   * and `/events` are already registered; later WS endpoints (the Author
   * stream) call `upgradeRouter.register(...)` on it.
   */
  upgradeRouter: UpgradeRouter;
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
  /**
   * The app's one AuthorTurnRunner, shared by the `/assistant/*` REST
   * routes and `WS /assistant/stream`. Test seam (a runner with the
   * `providerFor` seam on `mockModel`); defaults to the real key-backed
   * runner `createAuthorRunner` builds - like `createApp`'s `authorRunner`
   * option, which this is passed straight through to.
   */
  authorRunner?: AuthorTurnRunner;
  /**
   * The launch workspace's IdleVersioner - a test seam like `authorRunner`:
   * inject one with a spy `capture` (or a long `delayMs`) to observe the
   * PUT/POST/DELETE/`close()` wiring. Defaults to the workspace context's
   * own `createIdleVersioner(versions)` (storage/idleVersioner.ts).
   */
  idleVersioner?: IdleVersioner;
  /**
   * The Studio home directory (`configureStudioHome`'s argument - every
   * Studio-global store derives its files from it). Defaults to
   * `<baseDir>/.lousho`, where the launch folder's files already live;
   * tests pass a temp dir so they never touch a real home (W02b).
   */
  studioHome?: string;
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

/**
 * The bundled SDK docs folder `searchDocs` reads: three levels above this
 * file's dir lands on the package root (server/ and dist-server/ are both
 * at apps/agent-forge/<x>, same resolution as the default staticDir).
 * `docs/*.md` ships in the package's `files`; a missing folder makes
 * `searchDocs` answer UNAVAILABLE rather than fail.
 */
function resolveDocsDir(moduleDir: string): string {
  return path.join(moduleDir, '..', '..', '..', 'docs');
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
  configureStudioHome(options.studioHome ?? path.join(baseDir, '.lousho'));
  const paths = studioPaths();
  const secretsStore = new SecretsStore(paths);
  const settingsStore = new SettingsStore(paths);

  // The launch folder is added to the workspace registry on every start
  // (`ensure` keeps one entry and bumps lastOpenedAt on a restart) and
  // its stored ref is the launch context's identity.
  const registry = new WorkspaceRegistry(paths.workspaces);
  const launchRef = await registry.ensure(baseDir);
  // The app's one pass runner + spend log (passes/): Studio-global, shared
  // by every workspace context through WorkspaceServices, and the same
  // instances the spend route and `close()` use.
  const spendLog = new SpendLog(paths.spend);
  const passRunner = new PassRunner({
    baseDir,
    spendLog,
    isEnabled: (kind) => settingsStore.passes().enabled[kind],
  });
  // The Studio-global inbox alert store (L12): the failure-streak pass
  // writes `auto_disabled` alerts here per workspace; R02a's inbox routes
  // read the same instance off the app options.
  const alerts = new AlertStore(paths.alerts);
  // The Studio-global stores every workspace context shares (W02a): the
  // manager's `build` reuses this exact object, so a lazily-built context
  // gets the same passRunner/spendLog/alerts/secrets/settings as launch.
  const services: WorkspaceServices = {
    secretsStore,
    settingsStore,
    observe: options.observe !== false,
    passRunner,
    spendLog,
    alerts,
  };
  const workspace = createWorkspaceContext(launchRef, services);
  // Every registered workspace resolves over HTTP through this manager:
  // contexts build lazily on first use, stay warm up to the cap, and idle
  // ones dispose - the launch context is always warm and never a
  // candidate (workspace/workspaceManager.ts).
  const workspaces = new WorkspaceManager({ registry, launch: workspace, build: (ref) => createWorkspaceContext(ref, services) });
  // A test-injected versioner replaces the context's default one before the
  // app and `close()` below both read `workspace.idleVersioner`.
  if (options.idleVersioner !== undefined) workspace.idleVersioner = options.idleVersioner;

  const token = options.token ?? (process.env[STUDIO_TOKEN_ENV] || mintStudioToken());
  const allowedOrigins = (process.env[STUDIO_ALLOWED_ORIGINS_ENV] ?? '').split(',').filter(Boolean);
  const access = { token, allowedHosts: allowedHostsFor(host), allowedOrigins };
  const docsDir = resolveDocsDir(moduleDir);
  // The Author's session store, template catalog and turn runner are built
  // here - not inside createApp - because `WS /assistant/stream` needs the
  // same instances the REST routes use: the runner's turn slots are what
  // the one-running-turn-per-session rule and the DELETE 409 hang on, and
  // the session store is what the stream's `?session=` existence check
  // reads. Both are handed to createApp so it uses these, not fresh ones.
  const authorSessions = new AuthorSessionStore(paths.sessions);
  const templateCatalog = new TemplateCatalog();
  const authorRunner =
    options.authorRunner ??
    createAuthorRunner({
      sessions: authorSessions,
      settings: settingsStore,
      secrets: secretsStore,
      templates: templateCatalog,
      docsDir,
      workspaceResolver: workspaces,
    });
  const app = createApp({
    workspace,
    baseDir,
    studioHome: paths.home,
    secretsStore,
    settingsStore,
    workspaceRegistry: registry,
    workspaces,
    warm: () => workspaces.warm(),
    staticDir,
    docsDir,
    access,
    eventBus: workspace.events,
    sessions: authorSessions,
    authorRunner,
    templateCatalog,
    spendLog,
    passRunner,
    alerts,
  });
  const server = http.createServer(app);
  // One upgrade listener for every WS endpoint: the shared Host/Origin/
  // token gate runs in the router, then the first registered route wins.
  const upgradeRouter = createUpgradeRouter(server, access);
  attachWebSocketServer(upgradeRouter, workspaces);
  attachEventsWebSocket(upgradeRouter, workspaces);
  upgradeRouter.register(
    AUTHOR_STREAM_PATH,
    createAuthorUpgradeHandler({ runner: authorRunner, sessions: authorSessions })
  );

  await listen(server, port, host);
  const judgeOption = options.judge ?? (options.observe === false ? false : {});
  const judgeLoop = judgeOption === false ? undefined : startJudgeLoop({ ...judgeOption, secretsStore });
  const boundPort = (server.address() as { port: number }).port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  return {
    server,
    port: boundPort,
    runManager: workspace.runs,
    upgradeRouter,
    token,
    url: `http://${urlHost}:${boundPort}/?token=${encodeURIComponent(token)}`,
    close: async () => {
      judgeLoop?.stop();
      // Abort in-flight passes and settle queued ones; running jobs get the
      // abort signal and their records land if they settle before exit.
      passRunner.close();
      // Dispose every warm workspace context (launch included) - each
      // flushes its idle-version captures and stops its inbox/triggers/
      // cron - before the socket stops taking writes.
      await workspaces.close();
      // The explicit launch stops stay for the `options.idleVersioner`
      // test seam, which replaces `workspace.idleVersioner` after the
      // context built its own (dispose flushes the original).
      await workspace.idleVersioner.flushAll();
      workspace.inbox.stop();
      workspace.triggers.stop();
      workspace.cron.stop();
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
