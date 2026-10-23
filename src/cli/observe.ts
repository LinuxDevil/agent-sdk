/**
 * `lousho observe` - the collector daemon command. It owns the single writer
 * to `~/.lousho/observe.db` and serves the ingest + Studio read API.
 *
 *   lousho observe start [--port N] [--db path] [--host H] [--require-token]
 *   lousho observe status [--port N | --url U]
 *   lousho observe stop [--db path]
 *   lousho observe rebuild-rollups [--db path]
 *   lousho observe token create --project X [--db path]
 *
 * `start` runs in the foreground (like `lousho dev`). On EADDRINUSE it probes
 * `GET /health`: a `lousho-observe` answer means the daemon is already
 * running (exit 0); anything else is a real port collision. `stop` uses the
 * pidfile `start` wrote beside the db. `token create` is a local db op - it
 * needs no running daemon - and prints the key once (only its hash is kept).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultDbPath,
  defaultPidPath,
  isObserveDaemon,
  probeHealth,
  startObserveDaemon,
  type HealthProbe,
} from '../observe/daemon';
import { createToken, hasTokens, openDb, rebuildRollups } from '../observe/store';
import { OBSERVE_DEFAULT_PORT, OBSERVE_SERVICE } from '../observe/envelope';
import { VERSION } from '../version';
import { exitCodeFor, parseCommand, portValue, stringValue, usageError, type CommandSpec } from './args';

const USAGE = `Usage: lousho observe <command> [options]
  observe start [--port N] [--db path] [--host H] [--require-token]
  observe status [--port N] [--url U]
  observe stop [--db path]
  observe rebuild-rollups [--db path]
  observe token create --project X [--db path]`;

const HELP = `${USAGE}

Runs the observability collector: one SQLite store (default ~/.lousho/observe.db) that every
agent on this machine reports to when LOUSHO_OBSERVE=1, plus the read API Studio queries.

Options:
  --port N          listen port (default ${OBSERVE_DEFAULT_PORT}, or LOUSHO_OBSERVE_PORT)
  --db path         the SQLite file (default ~/.lousho/observe.db)
  --host H          bind address (default 127.0.0.1; a non-loopback bind requires a token and turns auth on)
  --require-token   require 'Authorization: Bearer <token>' on /api/v1/* even on loopback
  --url U           'status': the daemon's base URL (default http://127.0.0.1:<port>)
  --project X       'token create': the project the token is labeled for
  -h, --help        show this help`;

type ObserveSubcommand = 'start' | 'status' | 'stop' | 'rebuild-rollups' | 'token';

const SUB_SPECS: Record<ObserveSubcommand, CommandSpec> = {
  start: {
    command: 'observe start',
    usage: 'Usage: lousho observe start [--port N] [--db path] [--host H] [--require-token]',
    options: {
      port: { type: 'string' },
      db: { type: 'string' },
      host: { type: 'string' },
      'require-token': { type: 'boolean' },
    },
  },
  status: {
    command: 'observe status',
    usage: 'Usage: lousho observe status [--port N] [--url U]',
    options: { port: { type: 'string' }, url: { type: 'string' } },
  },
  stop: {
    command: 'observe stop',
    usage: 'Usage: lousho observe stop [--db path]',
    options: { db: { type: 'string' } },
  },
  'rebuild-rollups': {
    command: 'observe rebuild-rollups',
    usage: 'Usage: lousho observe rebuild-rollups [--db path]',
    options: { db: { type: 'string' } },
  },
  token: {
    command: 'observe token',
    usage: 'Usage: lousho observe token create --project X [--db path]',
    positionals: 1,
    options: { db: { type: 'string' }, project: { type: 'string' } },
  },
};

const SUBCOMMANDS = new Set<string>(Object.keys(SUB_SPECS));

function dbPathOf(value: string | boolean | (string | boolean)[] | undefined): string {
  const given = stringValue(value);
  return given === undefined ? defaultDbPath() : path.resolve(given);
}

function envPort(): number {
  const raw = process.env.LOUSHO_OBSERVE_PORT;
  if (raw === undefined) return OBSERVE_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : OBSERVE_DEFAULT_PORT;
}

/* ------------------------------------------------------------------- start */

async function runStart(args: string[]): Promise<number> {
  const spec = SUB_SPECS.start;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const port = portValue(spec, values.port, envPort());
  const dbPath = dbPathOf(values.db);
  const host = stringValue(values.host) ?? '127.0.0.1';
  const requireToken = values['require-token'] === true;
  const pidPath = defaultPidPath(dbPath);

  let daemon;
  try {
    daemon = await startObserveDaemon({ dbPath, port, host, requireToken, pidPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const health = await probeHealth(port, host);
      if (isObserveDaemon(health)) {
        console.log(`lousho observe: already running on http://${host}:${port} (service ${OBSERVE_SERVICE}, version ${health.version ?? 'unknown'}).`);
        return 0;
      }
      console.error(
        `lousho observe: port ${port} is taken by another service (its /health is not ${OBSERVE_SERVICE}). Pass --port <free>, or stop that service.`
      );
      return 1;
    }
    throw error;
  }

  console.log(`lousho observe: ${OBSERVE_SERVICE} v${VERSION} listening on http://${host}:${daemon.port}`);
  console.log(`lousho observe: db ${dbPath}`);
  if (daemon.requireToken) {
    console.log(
      hasTokens(daemon.db)
        ? 'lousho observe: bearer auth is ON; reporters need LOUSHO_OBSERVE_TOKEN=<key>.'
        : `lousho observe: bearer auth is ON but no tokens exist yet - create one: lousho observe token create --project <name>${dbPath === defaultDbPath() ? '' : ` --db ${dbPath}`}`
    );
  } else {
    console.log('lousho observe: agents emit with LOUSHO_OBSERVE=1 (no auth on loopback).');
  }
  // The listening server keeps the process alive, like `lousho dev`.
  return 0;
}

/* ------------------------------------------------------------------ status */

async function runStatus(args: string[]): Promise<number> {
  const spec = SUB_SPECS.status;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const port = portValue(spec, values.port, envPort());
  const base = stringValue(values.url) ?? `http://127.0.0.1:${port}`;
  let health: HealthProbe | undefined;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    health = res.ok ? ((await res.json()) as HealthProbe) : undefined;
  } catch {
    health = undefined;
  }
  if (!isObserveDaemon(health)) {
    console.error(`lousho observe: no collector at ${base} (start it with 'lousho observe start').`);
    return 1;
  }
  console.log(`lousho observe: running at ${base} (version ${health.version ?? 'unknown'})`);
  try {
    const res = await fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const status = (await res.json()) as { counts?: Record<string, number> };
      const counts = status.counts ?? {};
      console.log(
        `  ${counts.agents ?? 0} agents · ${counts.traces ?? 0} traces · ${counts.observations ?? 0} observations · ` +
          `${counts.sessions ?? 0} sessions · ${counts.scores ?? 0} scores`
      );
    } else {
      console.log('  (read endpoints are token-gated; counts not shown)');
    }
  } catch {
    // status already reported; counts are best effort
  }
  return 0;
}

/* -------------------------------------------------------------------- stop */

async function runStop(args: string[]): Promise<number> {
  const spec = SUB_SPECS.stop;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const dbPath = dbPathOf(values.db);
  const pidPath = defaultPidPath(dbPath);
  let pid: number | undefined;
  try {
    pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  } catch {
    pid = undefined;
  }
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    console.error(
      `lousho observe: no pidfile at ${pidPath}. If a daemon is running, stop it with Ctrl+C (or 'kill <pid>' / Task Manager).`
    );
    return 1;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      try {
        fs.rmSync(pidPath, { force: true });
      } catch {
        // stale pidfile already gone
      }
      console.log(`lousho observe: process ${pid} is already gone; removed the stale pidfile.`);
      return 0;
    }
    throw error;
  }
  console.log(`lousho observe: sent SIGTERM to pid ${pid}.`);
  return 0;
}

/* ------------------------------------------------------- rebuild / tokens */

async function runRebuild(args: string[]): Promise<number> {
  const spec = SUB_SPECS['rebuild-rollups'];
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const db = openDb(dbPathOf(values.db));
  try {
    const { buckets } = rebuildRollups(db);
    console.log(`lousho observe: rebuilt ${buckets} rollup buckets.`);
    return 0;
  } finally {
    db.close();
  }
}

async function runToken(args: string[]): Promise<number> {
  const spec = SUB_SPECS.token;
  const { values, positionals, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  if (positionals[0] !== 'create') throw usageError(spec, `expected 'create', got '${positionals[0] ?? ''}'.`);
  const project = stringValue(values.project);
  if (!project) throw usageError(spec, '--project is required (the label the token is created for).');
  const db = openDb(dbPathOf(values.db));
  try {
    const { key } = createToken(db, project);
    console.log(`lousho observe: token created for project '${project}'.`);
    console.log(key);
    console.log('Save it now - only its hash is stored, it cannot be shown again. Reporters send it as LOUSHO_OBSERVE_TOKEN.');
    return 0;
  } finally {
    db.close();
  }
}

/**
 * CLI entry point. Resolves with the exit code: 0 ok, 1 the subcommand ran and
 * failed (not running, real port collision), 2 bad arguments.
 */
export async function runObserve(rest: string[]): Promise<number> {
  const [sub, ...subArgs] = rest;
  if (sub === undefined || !SUBCOMMANDS.has(sub)) {
    if (sub === '--help' || sub === '-h' || sub === undefined) {
      console.log(HELP);
      return sub === undefined ? 2 : 0;
    }
    console.error(`lousho observe: unknown command '${sub}'.\n${USAGE}`);
    return 2;
  }
  try {
    switch (sub as ObserveSubcommand) {
      case 'start':
        return await runStart(subArgs);
      case 'status':
        return await runStatus(subArgs);
      case 'stop':
        return await runStop(subArgs);
      case 'rebuild-rollups':
        return await runRebuild(subArgs);
      case 'token':
        return await runToken(subArgs);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return exitCodeFor(error);
  }
}
