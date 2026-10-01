/**
 * LOU-N runtime control server entry point.
 *
 * Started either directly (`tsx server/index.ts`, e.g. from `loushy studio`
 * - see src/cli/studio.ts) or programmatically via `startStudioServer()`
 * for tests/embedding.
 */
import { once } from 'node:events';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFsAgentStore } from '../src/persistence/fsAgentStore';
import { createApp } from './app';
import { attachWebSocketServer } from './wsServer';
import { RunManager } from './runRegistry';
import { FileCheckpointStore } from './checkpointStore';
import { FileApprovalStore } from './approvalStore';
import { SecretsStore } from './secretsStore';
import { SettingsStore } from './settingsStore';

export interface StudioServerHandle {
  server: http.Server;
  port: number;
  runManager: RunManager;
  close: () => Promise<void>;
}

export interface StartStudioServerOptions {
  /** Directory `.loushy/agents/**` is read from/written to. Defaults to process.cwd(). */
  baseDir?: string;
  port?: number;
  host?: string;
  /**
   * S1: directory holding the built client (`vite build`'s output,
   * `apps/agent-forge/dist`) to serve as static files - see
   * `createApp`'s `staticDir` doc comment in `./app.ts`. Defaults to
   * `<this file's directory>/../dist`, i.e. `apps/agent-forge/dist`
   * alongside this server, which is where both `apps/agent-forge`'s own
   * `npm run build` and the SDK's `build:studio` script put it. Pass
   * `false` to explicitly disable static serving (dev mode, where Vite
   * itself serves the UI).
   */
  staticDir?: string | false;
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  server.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`[loushy studio] API server port ${port} is already in use.`);
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

  const agentStore = createFsAgentStore(baseDir);
  const checkpointStore = new FileCheckpointStore(baseDir);
  const approvalStore = new FileApprovalStore(baseDir);
  const secretsStore = new SecretsStore(baseDir);
  const settingsStore = new SettingsStore(baseDir);

  const runManager = new RunManager({
    baseDir,
    checkpointStore,
    approvalStore,
    loadSpec: (agentId) => agentStore.load(agentId),
    saveSpec: (agentId, spec) => agentStore.save(agentId, spec),
    secretsStore,
    settingsStore,
  });

  const app = createApp({ agentStore, runManager, baseDir, secretsStore, settingsStore, staticDir });
  const server = http.createServer(app);
  attachWebSocketServer(server, runManager);

  await listen(server, port, host);

  return {
    server,
    port,
    runManager,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Allow `tsx server/index.ts` (or `node --import tsx server/index.ts`) to
// boot the server directly, reading PORT/HOST/BASE_DIR from the
// environment - this is how `loushy studio` (src/cli/studio.ts) launches it
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
  // moduleDir is apps/agent-forge/server - the repo root (where `.loushy/`
  // should live) is three levels up, unless BASE_DIR is set explicitly.
  const baseDir = process.env.BASE_DIR ?? path.resolve(moduleDir, '..', '..', '..');
  // `src/cli/studio.ts` sets NO_STATIC=1 in dev mode (separate Vite dev
  // server process serves the UI there) and STATIC_DIR to override the
  // default `apps/agent-forge/dist` lookup in prod mode.
  const staticDir = process.env.NO_STATIC ? false : (process.env.STATIC_DIR ?? undefined);

  startStudioServer({ port, host, baseDir, staticDir })
    .then((handle) => {
      console.log(`[loushy studio] API server listening on http://${host ?? '127.0.0.1'}:${handle.port}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
