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
import { CollectorManager } from './collector';
import type { IdleVersioner } from './storage/idleVersioner';
import { STUDIO_ALLOWED_ORIGINS_ENV, STUDIO_TOKEN_ENV, allowedHostsFor, mintStudioToken } from './auth';
import { createWorkspaceContext, type WorkspaceContext, type WorkspaceServices } from './workspace/context';
import { WorkspaceManager } from './workspace/workspaceManager';
import { configureStudioHome, defaultStudioHome, studioPaths } from './workspace/studioPaths';
import { WorkspaceRegistry } from './workspace/workspaceRegistry';
import { AUTHOR_STREAM_PATH } from '../shared/authorWire';
import { AuthorSessionStore } from './author/sessionStore';
import { createAuthorUpgradeHandler } from './author/authorStream';
import { AuthorTurnRunner } from './author/turnRunner';
import { createAuthorRunner } from './author/wiring';
import { loadAuthorScript } from './author/authorScript';
import { TemplateCatalog } from './templates/templateCatalog';
import { PassRunner } from './passes/passRunner';
import { SpendLog } from './passes/spendLog';
import { AlertStore } from './inbox/alertStore';
import { ServeConfigStore } from './serve/serveConfigStore';
import { buildServeAgent } from './serve/serveRoutes';
import { McpServerManager } from './serve/mcpServers';
import type { StudioEvent } from '../shared/wireTypes';
import { VERSION } from 'lousho';

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
  /** The app's collector (collector.ts): `close()` already stopped a Studio-started daemon. */
  collector: CollectorManager;
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
   * The Studio home directory every Studio-global file lives under
   * (settings, secrets, Author sessions, the workspace registry, …).
   * Defaults to `defaultStudioHome()` - `LOUSHO_STUDIO_HOME` when set,
   * else `~/.lousho/studio`; tests pass a temp dir so they never touch a
   * real home (W03a).
   */
  studioHome?: string;
  /**
   * The collector (observe daemon) manager - `false` never starts one in
   * this process (`LOUSHO_STUDIO_COLLECTOR=0` does the same; the e2e server
   * uses it against its observe stub), a `CollectorManager` is used as-is
   * (tests), and the default builds one over the app's settings/secrets
   * stores and `start()`s it before `listen` (collector.ts).
   */
  collector?: false | CollectorManager;
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

/**
 * The launch workspace's registry entry plus the warm launch context and
 * the `WorkspaceManager` every other registered workspace resolves
 * through - extracted from `startStudioServer` so the boot function stays
 * a flat wiring list.
 */
async function buildWorkspaceStack(
  options: StartStudioServerOptions,
  paths: ReturnType<typeof studioPaths>,
  deps: {
    baseDir: string;
    secretsStore: SecretsStore;
    settingsStore: SettingsStore;
    spendLog: SpendLog;
    passRunner: PassRunner;
    alerts: AlertStore;
    collector: CollectorManager;
  }
): Promise<{ registry: WorkspaceRegistry; workspace: WorkspaceContext; workspaces: WorkspaceManager }> {
  const { baseDir, secretsStore, settingsStore, spendLog, passRunner, alerts, collector } = deps;
  // The launch folder is added to the workspace registry on every start
  // (`ensure` keeps one entry and bumps lastOpenedAt on a restart) and
  // its stored ref is the launch context's identity.
  const registry = new WorkspaceRegistry(paths.workspaces);
  const launchRef = await registry.ensure(baseDir);
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
    // W12: the one CollectorManager feeds run reporting here and bridge
    // children through the host selector's env (context.ts adapts it).
    collector,
    studioVersion: VERSION,
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
  return { registry, workspace, workspaces };
}

// fallow-ignore-next-line complexity
export async function startStudioServer(
  options: StartStudioServerOptions = {}
): Promise<StudioServerHandle> {
  const baseDir = options.baseDir ?? process.cwd();
  const port = options.port ?? 4750;
  const host = options.host ?? '127.0.0.1';
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = resolveStaticDir(options.staticDir, moduleDir);

  // Global state lives in the Studio home (`LOUSHO_STUDIO_HOME` or
  // `~/.lousho/studio`), shared across every workspace Studio opens; a
  // workspace's old project-level `.lousho/` settings/secrets can be
  // imported once through `POST /workspaces/:ws/legacy-import`.
  configureStudioHome(options.studioHome ?? defaultStudioHome());
  const paths = studioPaths();
  const secretsStore = new SecretsStore(paths);
  const settingsStore = new SettingsStore(paths);
  // The one collector every daemon client follows (collector.ts): attach
  // to a running daemon, start one on a loopback URL, or report a remote
  // one down. `LOUSHO_STUDIO_COLLECTOR=0` / `collector: false` only ever
  // attaches - nothing is spawned in this process.
  const collector =
    options.collector !== undefined && options.collector !== false
      ? options.collector
      : new CollectorManager({
          settings: settingsStore,
          secrets: secretsStore,
          ...(options.collector === false ? { autoStart: false } : {}),
        });

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
  const { registry, workspace, workspaces } = await buildWorkspaceStack(options, paths, {
    baseDir,
    secretsStore,
    settingsStore,
    spendLog,
    passRunner,
    alerts,
    collector,
  });

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
  // X08: the e2e hook's scripted provider wins over key resolution; a bad
  // script file fails startup here, before the server listens.
  const authorScript = loadAuthorScript();
  const authorRunner =
    options.authorRunner ??
    createAuthorRunner({
      sessions: authorSessions,
      settings: settingsStore,
      secrets: secretsStore,
      templates: templateCatalog,
      docsDir,
      workspaceResolver: workspaces,
      ...(authorScript !== undefined ? { scriptedProvider: authorScript } : {}),
    });
  // The `/serve/<id>` config store is created here (not left to createApp's
  // default) so the X03 MCP manager shares the same instance the serve
  // routes read - token rotations stay consistent without a second file
  // reader racing the atomic writes.
  const serveConfig = new ServeConfigStore(paths.serve);
  // The X03 MCP server manager: one per Studio app, restarted on
  // `agent.changed` version/meta events and closed on shutdown. The agent
  // builder is the serve surface's own (`buildServeAgent`) so MCP calls
  // get the same sessions, approvals and trace export as `/serve/<id>`.
  const mcpServers = new McpServerManager({
    repo: workspace.repo,
    versions: workspace.versions,
    serveConfig,
    buildAgent: (spec, agentId) =>
      buildServeAgent(spec, agentId, workspace, {
        secretsStore,
        settings: settingsStore,
        spendLog,
      }),
  });
  const unsubMcpRefresh = workspace.events.subscribe((event: StudioEvent) => {
    if (event.type === 'agent.changed' && (event.reason === 'version' || event.reason === 'meta')) {
      void mcpServers.refresh(event.agentId);
    }
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
    serveConfig,
    mcpServers,
    collector,
  });
  const server = http.createServer(app);
  // One upgrade listener for every WS endpoint: the shared Host/Origin/
  // token gate runs in the router, then the first registered route wins.
  const upgradeRouter = createUpgradeRouter(server, access);
  attachWebSocketServer(upgradeRouter, workspaces);
  // `WS /events?ws=all` (W09a): every warm context's events tagged by
  // workspace plus the Studio-wide inbox count; onBuilt/onDisposed keep
  // the socket's subscription set following lazily-built contexts.
  attachEventsWebSocket(upgradeRouter, workspaces, {
    registry,
    warm: () => workspaces.warm(),
    alerts,
    onBuilt: (listener) => workspaces.onBuilt(listener),
    onDisposed: (listener) => workspaces.onDisposed(listener),
  });
  upgradeRouter.register(
    AUTHOR_STREAM_PATH,
    createAuthorUpgradeHandler({ runner: authorRunner, sessions: authorSessions })
  );

  // The collector resolves (attach or in-process start) before the API
  // listens, so the first `/observe` request already has a target.
  await collector.start();

  await listen(server, port, host);
  const judgeOption = options.judge ?? (options.observe === false ? false : {});
  const judgeLoop =
    judgeOption === false ? undefined : startJudgeLoop({ ...judgeOption, secretsStore, collector });
  const boundPort = (server.address() as { port: number }).port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  return {
    server,
    port: boundPort,
    runManager: workspace.runs,
    upgradeRouter,
    token,
    url: `http://${urlHost}:${boundPort}/?token=${encodeURIComponent(token)}`,
    collector,
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
      unsubMcpRefresh();
      // Stop every running MCP server (X03) before the HTTP socket closes.
      await mcpServers.closeAll();
      // A daemon this Studio started stops with it; an attached one is left alone.
      await collector.stop();
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
      const collector = handle.collector.status();
      if (collector.mode === 'started') {
        console.log(`[lousho studio] Collector: started on ${collector.url} (stops with Studio)`);
      } else if (collector.mode === 'attached') {
        console.log(`[lousho studio] Collector: attached to ${collector.url}`);
      } else if (collector.mode === 'remote') {
        console.log(`[lousho studio] Collector: remote ${collector.url}`);
      } else {
        console.log(`[lousho studio] Collector: not reachable (${collector.error ?? 'unknown'})`);
      }
      // `lousho studio` mints the token itself and prints this URL; only print it when launched directly.
      if (!process.env[STUDIO_TOKEN_ENV]) console.log(`[lousho studio] Agent Forge: ${handle.url}`);
      const shutdown = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
