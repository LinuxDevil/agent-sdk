/**
 * The collector daemon: a loopback-only `node:http` server owning the only
 * handle to the observe database (single-writer rule; Studio reads through
 * its routes, never the file).
 *
 * - Bind address defaults to `127.0.0.1`: the threat model trusts any
 *   loopback process. A non-loopback `--host` turns token auth ON by itself
 *   (the node server rule: no unauthenticated public bind), and
 *   `--require-token` turns it on explicitly. `/health` always answers
 *   without auth - it is the `lousho-observe` marker the port-collision
 *   probe needs.
 * - Routes live in `src/observe/routes/*` and dispatch through
 *   `matchRoute()`; the daemon owns body limits, auth, and error mapping,
 *   never per-endpoint logic.
 * - On `EADDRINUSE` the CLI probes `GET /health`: a `lousho-observe` answer
 *   means "already running" (exit 0); anything else is a real collision.
 */

import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SDKError } from '../execution/errors';
import { isLoopbackHost } from '../server/hostCheck';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { OBSERVE_DEFAULT_PORT, OBSERVE_SERVICE } from './envelope';
import { BodyTooLargeError, matchRoute, sendJson, type RouteContext } from './routes/index';
import { createAlerter, resolveAlertConfig, type AlertConfig } from './alerts';
import { startStatusSweep, type StatusSweep } from './sweep';
import { openDb, verifyToken } from './store';

/** `~/.lousho/observe.db`. */
export function defaultDbPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.lousho', 'observe.db');
}

/**
 * Where the pidfile goes for a given db path: `<dir>/<db name without .db>.pid`,
 * so two daemons whose dbs share a folder never share a pidfile
 * (`observe.db` keeps `observe.pid`).
 */
export function defaultPidPath(dbPath: string): string {
  const resolved = resolveForFs(dbPath);
  const base = path.basename(resolved);
  const stem = base.toLowerCase().endsWith('.db') && base.length > 3 ? base.slice(0, -3) : base;
  return path.join(path.dirname(resolved), `${stem}.pid`);
}

/** Whether two db paths name the same file (resolved; case-insensitive on win32). */
export function sameDbPath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const norm = (p: string): string => (process.platform === 'win32' ? resolveForFs(p).toLowerCase() : resolveForFs(p));
  return norm(a) === norm(b);
}

function resolveForFs(p: string): string {
  return p === ':memory:' ? p : path.resolve(p);
}

export interface ObserveDaemonOptions {
  /** SQLite file; default `~/.lousho/observe.db` (`:memory:` for tests). */
  dbPath?: string;
  /** Default 7777; `0` picks an ephemeral port (tests). */
  port?: number;
  /** Bind address; default `127.0.0.1`. Non-loopback forces token auth on. */
  host?: string;
  /** Require `Authorization: Bearer <token>` on `/api/v1/*` even on loopback. */
  requireToken?: boolean;
  /** Write the pid here on listen, remove on close (for `lousho observe stop`). */
  pidPath?: string;
  /** An already-open db (tests inject one); otherwise `openDb(dbPath)`. */
  db?: SqlDatabase;
  /** Injectable for tests; defaults to the global fetch. Used by the alert webhooks. */
  fetchFn?: typeof fetch;
  /** Extra alert webhooks (repeatable `--webhook`); merged with `alerts.json` beside the db. */
  webhooks?: string[];
  /** Status-sweep cadence in ms (default 30s); `<= 0` leaves the sweep manual-only (tests). */
  sweepIntervalMs?: number;
  /** Injectable clock for the sweep (tests); default `Date.now`. */
  nowFn?: () => number;
}

export interface ObserveDaemon {
  port: number;
  host: string;
  dbPath: string;
  /** Whether bearer auth is enforced (non-loopback bind implies it). */
  requireToken: boolean;
  server: http.Server;
  db: SqlDatabase;
  pidPath?: string;
  /** The resolved alert config (`alerts.json` + `--webhook` flags). */
  alerts: AlertConfig;
  /** The running status sweep (`run()` forces a pass; `stop()` is called by `close()`). */
  sweep: StatusSweep;
  close(): Promise<void>;
}

function readBodyCapped(req: http.IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (settled && !overflowed) return;
      if (overflowed) return; // drain the rest so the 413 response can land cleanly
      size += chunk.length;
      if (size > limitBytes) {
        // Keep draining (discarding) - answering mid-upload and closing the socket
        // makes clients report "socket closed" instead of seeing the 413.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (overflowed) {
        rejectPromise(new BodyTooLargeError(`Request body exceeds the ${Math.round(limitBytes / 1024 / 1024)}MB limit.`));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
  });
}

/** The `Authorization: Bearer <key>` value, or undefined. */
function bearerOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/** Start the daemon. Rejects with the listen error (`EADDRINUSE` keeps `code` for the CLI's health probe). */
export async function startObserveDaemon(options: ObserveDaemonOptions = {}): Promise<ObserveDaemon> {
  const dbPath = options.dbPath ?? defaultDbPath();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? OBSERVE_DEFAULT_PORT;
  // Resolve before opening anything: a malformed alerts.json should fail the
  // start loudly (silently dropping it would leave alerts "configured" but dead).
  const alertConfig = resolveAlertConfig(dbPath, options.webhooks ?? []);
  const db = options.db ?? openDb(dbPath);
  const requireToken = options.requireToken === true || !isLoopbackHost(host);

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
    if (requireToken && isApiPath(pathname) && !verifyToken(db, bearerOf(req))) {
      return sendJson(res, 401, {
        error: 'This observe daemon requires a bearer token; create one with `lousho observe token create --project <name>`.',
        code: 'LOUSHO_REMOTE_UNAUTHORIZED',
      });
    }
    const match = matchRoute(req.method ?? 'GET', pathname);
    if (!match) return sendJson(res, 404, { error: 'not found', code: 'LOUSHO_REQUEST_INVALID' });
    let bodyRead: Promise<string> | undefined;
    const ctx: RouteContext = {
      db,
      dbPath,
      req,
      res,
      params: match.params,
      query: searchParams,
      readBody(limitBytes: number) {
        bodyRead ??= readBodyCapped(req, limitBytes);
        return bodyRead;
      },
    };
    try {
      await match.route.handle(ctx);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return sendJson(res, 413, { error: error.message, code: 'LOUSHO_REQUEST_INVALID' });
      }
      if (error instanceof SDKError && error.code === 'LOUSHO_REQUEST_INVALID') {
        return sendJson(res, 400, { error: error.detail, code: error.code });
      }
      console.error('[lousho observe] request failed:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', code: 'LOUSHO_GENERIC_ERROR' });
      else res.end();
    }
  };

  const server = http.createServer((req, res) => {
    void onRequest(req, res);
  });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.once('listening', () => {
        server.removeListener('error', rejectPromise);
        resolvePromise();
      });
      server.listen(port, host);
    });
  } catch (error) {
    // A failed bind (EADDRINUSE and friends) must not leak the db handle the
    // daemon opened above - the CLI exits on the error, but tests and embedded
    // callers would keep the WAL lock forever.
    if (!options.db) db.close();
    throw error;
  }

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  const pidPath = options.pidPath;
  if (pidPath !== undefined) {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // Line 2 is the port, so `stop` can ask this daemon which db it serves.
    fs.writeFileSync(pidPath, `${process.pid}\n${boundPort}\n`, 'utf8');
  }

  // The monitoring sweep: rewrites agents.status from heartbeat freshness,
  // interrupts a crashed agent's open work, and posts alerts to webhooks
  // (fire-and-forget; delivery lives in alerts.ts).
  const alerter = createAlerter(alertConfig, options.fetchFn ?? fetch);
  const sweep = startStatusSweep(db, {
    intervalMs: options.sweepIntervalMs,
    now: options.nowFn,
    errorRateThreshold: alertConfig.errorRateThreshold,
    onAlerts: (alerts) => alerter.post(alerts),
  });

  return {
    port: boundPort,
    host,
    dbPath,
    requireToken,
    server,
    db,
    alerts: alertConfig,
    sweep,
    ...(pidPath !== undefined ? { pidPath } : {}),
    close: async () => {
      sweep.stop();
      if (pidPath !== undefined) {
        try {
          fs.rmSync(pidPath, { force: true });
        } catch {
          // best effort; a stale pidfile is reported by `stop`, not fatal
        }
      }
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()))
      );
      if (!options.db) db.close();
    },
  };
}

export interface HealthProbe {
  service: string;
  ok: boolean;
  version?: string;
  /** Absolute path of the db the daemon serves. */
  db?: string;
}

/**
 * `GET /health` on `host:port`; `undefined` when nothing answers. Used by
 * `start`'s EADDRINUSE handling and by `lousho observe status`.
 */
export async function probeHealth(port: number, host = '127.0.0.1', fetchFn: typeof fetch = fetch): Promise<HealthProbe | undefined> {
  try {
    const res = await fetchFn(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthProbe;
  } catch {
    return undefined;
  }
}

/** Whether the health answer is a lousho-observe daemon's (the attach-detection marker). */
export function isObserveDaemon(health: HealthProbe | undefined): health is HealthProbe {
  return health?.service === OBSERVE_SERVICE && health.ok === true;
}
