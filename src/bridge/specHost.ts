/**
 * The {@link SpecHost} `lousho bridge` compiles and runs project specs
 * against (W10a; W10b reuses it for `run`/`chat`): paths resolve under the
 * project's `.lousho/agents` (the same base Studio's D12a uses), named
 * `{ secret }` refs read the params' `secrets` map, `{ env }` refs read the
 * process env (Studio's `env` params were already applied to it), and each
 * agent id gets one cached `fileStore` under `.lousho/agents/<agentId>`.
 * FileStore ids are case-safe encoded on disk (`Alice` → `^alice`) — W11c
 * relies on that when it maps store paths back to agent ids.
 */
import * as path from 'node:path';
import type { TraceExporter } from '../execution/tracing';
import type { SpecHost } from '../spec/v2/host';
import { fileStore, type FileStore } from '../storage/fileStore';

/** The params a spec host needs: which agent the store is for and the secrets its `{ secret }` refs resolve through. */
export interface BridgeSpecParams {
  agentId: string;
  secrets?: Record<string, string>;
}

/** `fileStore`s already opened, keyed by `<root>/<agentId>` so one bridge process shares a store per agent. */
const stores = new Map<string, FileStore>();

function storeFor(root: string, agentId: string): FileStore {
  const key = path.join(root, agentId);
  let store = stores.get(key);
  if (store === undefined) {
    store = fileStore(path.join(root, '.lousho', 'agents', agentId));
    stores.set(key, store);
  }
  return store;
}

/**
 * Applies Studio's stored provider keys (`params.env`, already shape-checked
 * by the params schema): each entry lands on `process.env`, so a project's
 * `.env` value loses to the stored key — matching D12a's "stored key, else
 * env" precedence.
 */
export function applyEnv(env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    process.env[key] = value;
  }
}

/**
 * The host for `agentId`'s spec under project root `root`. `extras.exporter`
 * is W10b's trace exporter; `compile` leaves it unset.
 */
export function bridgeSpecHost(root: string, params: BridgeSpecParams, extras?: { exporter?: TraceExporter }): SpecHost {
  return {
    baseDir: path.join(root, '.lousho', 'agents'),
    resolveSecret: (name) => params.secrets?.[name],
    env: process.env,
    store: storeFor(root, params.agentId),
    ...(extras?.exporter !== undefined && { exporter: extras.exporter }),
  };
}
