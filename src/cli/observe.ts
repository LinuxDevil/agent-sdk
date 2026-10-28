/**
 * `lousho observe` - the collector daemon command. It owns the single writer
 * to `~/.lousho/observe.db` and serves the ingest + Studio read API.
 *
 *   lousho observe start [--port N] [--db path] [--host H] [--require-token] [--retention-days N] [--session-idle-minutes N]
 *   lousho observe status [--port N | --url U]
 *   lousho observe stop [--db path]
 *   lousho observe rebuild-rollups [--db path]
 *   lousho observe prune --older-than <N>d [--db path]
 *   lousho observe export [--since <N>d|<N>h|<N>m] [--agent X] [--out file] [--db path]
 *   lousho observe token create --project X [--db path]
 *
 * `start` runs in the foreground (like `lousho dev`). On EADDRINUSE it probes
 * `GET /health`: a `lousho-observe` answer means the daemon is already
 * running (exit 0); anything else is a real port collision. `stop` uses the
 * pidfile `start` wrote beside the db. `token create`, `prune` and `export` are local db
 * ops - they need no running daemon (and are safe beside one: WAL, busy
 * timeout) - and `token create` prints the key once (only its hash is kept).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultDbPath,
  defaultPidPath,
  isObserveDaemon,
  OBSERVE_RETENTION_DAYS_DEFAULT,
  OBSERVE_SESSION_IDLE_MINUTES_DEFAULT,
  sameDbPath,
  probeHealth,
  startObserveDaemon,
  urlHost,
  type HealthProbe,
} from '../observe/daemon';
import { createToken, hasTokens, listTraces, openDb, pruneBefore, rebuildRollups, traceDetail, type TraceFilter } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { OBSERVE_DEFAULT_PORT, OBSERVE_SERVICE } from '../observe/envelope';
import { VERSION } from '../version';
import { exitCodeFor, parseCommand, portValue, stringValue, usageError, type CommandSpec } from './args';

const USAGE = `Usage: lousho observe <command> [options]
  observe start [--port N] [--db path] [--host H] [--require-token] [--webhook URL] [--retention-days N] [--session-idle-minutes N]
  observe status [--port N] [--url U]
  observe stop [--db path]
  observe rebuild-rollups [--db path]
  observe prune --older-than <N>d [--db path]
  observe export [--since <N>d|<N>h|<N>m] [--agent X] [--out file] [--db path]
  observe token create --project X [--db path]`;

const HELP = `${USAGE}

Runs the observability collector: one SQLite store (default ~/.lousho/observe.db) that every
agent on this machine reports to when LOUSHO_OBSERVE=1, plus the read API Studio queries.

Options:
  --port N          listen port (default ${OBSERVE_DEFAULT_PORT}, or LOUSHO_OBSERVE_PORT)
  --db path         the SQLite file (default ~/.lousho/observe.db)
  --host H          bind address (default 127.0.0.1; a non-loopback bind requires a token and turns auth on)
  --require-token   require 'Authorization: Bearer <token>' on /api/v1/* even on loopback
  --webhook URL     'start': POST alert JSON to this URL when an agent goes down or its error
                    rate spikes (repeatable). Also reads 'alerts.json' beside the db:
                    {"webhooks": [...], "errorRateThreshold": 0.5}
  --retention-days N
                    'start': once a day, delete finished traces older than N days (default
                    ${OBSERVE_RETENTION_DAYS_DEFAULT}; 0 keeps everything). Open runs, active sessions,
                    rollups, prompts and hub entries are never pruned.
  --session-idle-minutes N
                    'start': end a session once nothing in it has run for N minutes (default
                    ${OBSERVE_SESSION_IDLE_MINUTES_DEFAULT}; 0 keeps sessions active until their agent goes down).
                    New activity reopens it; retention then prunes ended sessions.
  --older-than <N>d 'prune': delete finished traces older than N days now, then VACUUM the db
  --since <N>d      'export': only traces that started within the last N days (or <N>h / <N>m)
  --agent X         'export': only this agent (its agent_id, or its name when that names one agent)
  --out file        'export': write the JSONL to this file instead of stdout
  --url U           'status': the daemon's base URL (default http://127.0.0.1:<port>)
  --project X       'token create': the project the token is labeled for
  -h, --help        show this help`;

type ObserveSubcommand = 'start' | 'status' | 'stop' | 'rebuild-rollups' | 'prune' | 'export' | 'token';

const SUB_SPECS: Record<ObserveSubcommand, CommandSpec> = {
  start: {
    command: 'observe start',
    usage: 'Usage: lousho observe start [--port N] [--db path] [--host H] [--require-token] [--webhook URL] [--retention-days N] [--session-idle-minutes N]',
    options: {
      port: { type: 'string' },
      'retention-days': { type: 'string' },
      'session-idle-minutes': { type: 'string' },
      db: { type: 'string' },
      host: { type: 'string' },
      'require-token': { type: 'boolean' },
      webhook: { type: 'string', multiple: true },
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
  prune: {
    command: 'observe prune',
    usage: 'Usage: lousho observe prune --older-than <N>d [--db path]',
    options: { db: { type: 'string' }, 'older-than': { type: 'string' } },
  },
  export: {
    command: 'observe export',
    usage: 'Usage: lousho observe export [--since <N>d|<N>h|<N>m] [--agent X] [--out file] [--db path]',
    options: { db: { type: 'string' }, since: { type: 'string' }, agent: { type: 'string' }, out: { type: 'string' } },
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

/** A `multiple: true` string flag's values (a single use still lands as one element). */
function stringListValue(value: string | boolean | (string | boolean)[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  const single = stringValue(value);
  return single === undefined ? [] : [single];
}

const DAY_MS = 86_400_000;

/** A non-negative integer flag (`--retention-days N`, `--session-idle-minutes N`; 0 disables), or `fallback` when absent. */
function wholeNumberValue(
  spec: CommandSpec,
  flag: string,
  meaning: string,
  value: string | boolean | (string | boolean)[] | undefined,
  fallback: number
): number {
  const given = stringValue(value);
  if (given === undefined) return fallback;
  if (!/^\d+$/.test(given)) throw usageError(spec, `${flag} must be a non-negative integer (${meaning}), got '${given}'.`);
  return Number(given);
}

/** `--older-than <N>d`: a positive whole number of days (`30d`); anything else is a usage error. */
function olderThanDays(spec: CommandSpec, value: string | boolean | (string | boolean)[] | undefined): number {
  const given = stringValue(value);
  if (given === undefined) throw usageError(spec, '--older-than <N>d is required (e.g. --older-than 30d).');
  const days = Number(/^(\d+)d$/.exec(given)?.[1] ?? 0);
  if (days <= 0) throw usageError(spec, `--older-than must be a positive number of days like '30d', got '${given}'.`);
  return days;
}

const SINCE_UNIT_MS: Record<string, number> = { d: DAY_MS, h: 3_600_000, m: 60_000 };

/** `--since <N>d|<N>h|<N>m`: a positive whole duration back from now, as a ms epoch; absent means no lower bound. */
function sinceMs(spec: CommandSpec, value: string | boolean | (string | boolean)[] | undefined): number | undefined {
  const given = stringValue(value);
  if (given === undefined) return undefined;
  const match = /^(\d+)([dhm])$/.exec(given);
  const count = Number(match?.[1] ?? 0);
  if (match === null || count <= 0) throw usageError(spec, `--since must be a positive duration like '7d', '12h' or '30m', got '${given}'.`);
  return Date.now() - count * SINCE_UNIT_MS[match[2]];
}

function envPort(): number {
  const raw = process.env.LOUSHO_OBSERVE_PORT;
  if (raw === undefined) return OBSERVE_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : OBSERVE_DEFAULT_PORT;
}

/** The banner line telling agents how to reach this daemon: `=1` only reaches the default loopback port. */
export function reporterHint(host: string, port: number): string {
  const value = host === '127.0.0.1' && port === OBSERVE_DEFAULT_PORT ? '1' : `http://${urlHost(host)}:${port}`;
  return `lousho observe: agents emit with LOUSHO_OBSERVE=${value} (no auth on loopback).`;
}

/* ------------------------------------------------------------------- start */

/** `start` hit EADDRINUSE: say who owns the port. 0 = this db's daemon already runs; 1 = anything else. */
async function reportPortInUse(port: number, host: string, dbPath: string): Promise<number> {
  const health = await probeHealth(port, host);
  if (!isObserveDaemon(health)) {
    console.error(
      `lousho observe: port ${port} is taken by another service (its /health is not ${OBSERVE_SERVICE}). Pass --port <free>, or stop that service.`
    );
    return 1;
  }
  if (health.db !== undefined && !sameDbPath(health.db, dbPath)) {
    console.error(
      `lousho observe: port ${port} is serving ${health.db}, not ${dbPath}. Pass --port <free> for this db, or stop that daemon first.`
    );
    return 1;
  }
  console.log(`lousho observe: already running on http://${urlHost(host)}:${port} (service ${OBSERVE_SERVICE}, version ${health.version ?? 'unknown'}).`);
  return 0;
}

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
  const webhooks = stringListValue(values.webhook);
  const retentionDays = wholeNumberValue(spec, '--retention-days', 'days; 0 disables pruning', values['retention-days'], OBSERVE_RETENTION_DAYS_DEFAULT);
  const sessionIdleMinutes = wholeNumberValue(
    spec,
    '--session-idle-minutes',
    'minutes; 0 never ends idle sessions',
    values['session-idle-minutes'],
    OBSERVE_SESSION_IDLE_MINUTES_DEFAULT
  );
  const pidPath = defaultPidPath(dbPath);

  let daemon;
  try {
    daemon = await startObserveDaemon({ dbPath, port, host, requireToken, pidPath, webhooks, retentionDays, sessionIdleMinutes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return reportPortInUse(port, host, dbPath);
    throw error;
  }

  console.log(`lousho observe: ${OBSERVE_SERVICE} v${VERSION} listening on http://${urlHost(host)}:${daemon.port}`);
  console.log(`lousho observe: db ${dbPath}`);
  if (daemon.requireToken) {
    console.log(
      hasTokens(daemon.db)
        ? 'lousho observe: bearer auth is ON; reporters need LOUSHO_OBSERVE_TOKEN=<key>.'
        : `lousho observe: bearer auth is ON but no tokens exist yet - create one: lousho observe token create --project <name>${dbPath === defaultDbPath() ? '' : ` --db ${dbPath}`}`
    );
  } else {
    console.log(reporterHint(host, daemon.port));
  }
  if (daemon.alerts.webhooks.length > 0 || daemon.alerts.errorRateThreshold !== undefined) {
    const parts = [
      daemon.alerts.webhooks.length > 0
        ? `${daemon.alerts.webhooks.length} alert webhook${daemon.alerts.webhooks.length === 1 ? '' : 's'}`
        : 'no alert webhooks',
      daemon.alerts.errorRateThreshold !== undefined
        ? `error-rate alert at ${Math.round(daemon.alerts.errorRateThreshold * 100)}%`
        : undefined,
    ].filter(Boolean);
    console.log(`lousho observe: alerts on - ${parts.join(', ')}.`);
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

/** The pidfile's pid (line 1) and, for newer daemons, the port it listens on (line 2). */
function readPidfile(pidPath: string): { pid?: number; port?: number } {
  let text: string;
  try {
    text = fs.readFileSync(pidPath, 'utf8');
  } catch {
    return {};
  }
  const [pidLine = '', portLine] = text.split(/\r?\n/);
  const pid = Number(pidLine.trim());
  const port = Number(portLine?.trim());
  return {
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
  };
}

/**
 * What the daemon at the pidfile's port serves when that is not `dbPath`
 * (a different db, or another service); `undefined` when it matches or cannot
 * be verified (no port recorded, nothing answers).
 */
async function stopMismatch(port: number | undefined, dbPath: string): Promise<string | undefined> {
  if (port === undefined) return undefined;
  const health = await probeHealth(port);
  if (health === undefined) return undefined;
  if (!isObserveDaemon(health)) return 'another service';
  return health.db !== undefined && !sameDbPath(health.db, dbPath) ? health.db : undefined;
}

async function runStop(args: string[]): Promise<number> {
  const spec = SUB_SPECS.stop;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const dbPath = dbPathOf(values.db);
  const pidPath = defaultPidPath(dbPath);
  const { pid, port: pidPort } = readPidfile(pidPath);
  if (pid === undefined) {
    console.error(
      `lousho observe: no pidfile at ${pidPath}. If a daemon is running, stop it with Ctrl+C (or 'kill <pid>' / Task Manager).`
    );
    return 1;
  }
  const mismatch = await stopMismatch(pidPort, dbPath);
  if (mismatch !== undefined) {
    console.error(
      `lousho observe: pid ${pid} in ${pidPath} serves ${mismatch}, not ${dbPath}; not signalling it. Remove the stale pidfile if it is wrong.`
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

/**
 * `prune`: the retention pass on demand, then VACUUM to hand the space back.
 * Safe while the daemon runs (WAL + busy timeout): the delete is one
 * transaction, and VACUUM waits its turn behind ingest.
 */
async function runPrune(args: string[]): Promise<number> {
  const spec = SUB_SPECS.prune;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const days = olderThanDays(spec, values['older-than']);
  const db = openDb(dbPathOf(values.db));
  try {
    const counts = pruneBefore(db, Date.now() - days * DAY_MS);
    console.log(
      `lousho observe: pruned ${counts.observations} observations, ${counts.scores} scores, ${counts.sessions} sessions older than ${days}d.`
    );
    // The prune is committed: a failed VACUUM (busy, disk full) only costs the space back.
    try {
      db.exec('VACUUM');
    } catch (error) {
      console.error(`lousho observe: pruned, but VACUUM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** `--agent X`: an agent_id as is, else the one registered agent named X; two agents sharing a name is a usage error. */
function resolveAgent(spec: CommandSpec, db: SqlDatabase, given: string): string {
  if (db.prepare('SELECT 1 AS hit FROM agents WHERE agent_id = ?').get(given) !== undefined) return given;
  const named = db.prepare('SELECT agent_id FROM agents WHERE name = ?').all(given).map((r) => String(r.agent_id));
  if (named.length > 1) throw usageError(spec, `--agent '${given}' names ${named.length} agents (${named.join(', ')}); pass the agent_id.`);
  return named[0] ?? given;
}

const EXPORT_PAGE = 500;

/**
 * `export`: every matching trace as one JSONL line `{ trace, observations, scores }`,
 * oldest first, paged so the export is not capped. Read-only; needs no daemon.
 * The count goes to stderr when the lines go to stdout, so a pipe stays clean.
 */
async function runExport(args: string[]): Promise<number> {
  const spec = SUB_SPECS.export;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    console.log(HELP);
    return 0;
  }
  const since = sinceMs(spec, values.since);
  const out = stringValue(values.out);
  const db = openDb(dbPathOf(values.db));
  try {
    const agentGiven = stringValue(values.agent);
    const filter: TraceFilter = {
      from: since,
      agent_id: agentGiven === undefined ? undefined : resolveAgent(spec, db, agentGiven),
      sort: 'start',
      order: 'asc',
      limit: EXPORT_PAGE,
      offset: 0,
    };
    const lines: string[] = [];
    for (;;) {
      const { traces } = listTraces(db, filter);
      for (const trace of traces) {
        const detail = traceDetail(db, trace.trace_id);
        lines.push(JSON.stringify({ trace, observations: detail?.observations ?? [], scores: detail?.scores ?? [] }));
      }
      if (traces.length < EXPORT_PAGE) break;
      filter.offset += EXPORT_PAGE;
    }
    const summary = `lousho observe: exported ${lines.length} traces${out === undefined ? '' : ` to ${out}`}.`;
    if (out === undefined) {
      for (const line of lines) console.log(line);
      console.error(summary);
    } else {
      fs.writeFileSync(path.resolve(out), lines.map((line) => `${line}\n`).join(''));
      console.log(summary);
    }
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
      case 'prune':
        return await runPrune(subArgs);
      case 'export':
        return await runExport(subArgs);
      case 'token':
        return await runToken(subArgs);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return exitCodeFor(error);
  }
}
