/**
 * `lousho observe` against a real daemon on an ephemeral port and temp dbs:
 * status reports a running collector and misses a dead one, start answers
 * "already running" on the daemon's own port and 1 on a real collision, and
 * stop/rebuild/token work the local db. The listen-happy-path of `start`
 * stays in daemon.test.ts (a started daemon has no reachable handle here).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPidPath, startObserveDaemon, type ObserveDaemon } from '../observe/daemon';
import { ingestBatch, openDb } from '../observe/store';
import { loadDatabaseSync, type SqlDatabase } from '../storage/sqlite/driver';
import { reporterHint, runObserve } from './observe';

const daemons: ObserveDaemon[] = [];
const servers: http.Server[] = [];
let cwd: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-observe-cli-'));
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (daemons.length > 0) await daemons.pop()?.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function start(): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
  daemons.push(daemon);
  return daemon;
}

const dbPath = (): string => path.join(cwd, 'observe.db');

describe('reporterHint', () => {
  it('says LOUSHO_OBSERVE=1 only for the default loopback port', () => {
    expect(reporterHint('127.0.0.1', 7777)).toContain('LOUSHO_OBSERVE=1 ');
  });

  it('names the base url on a non-default port or host', () => {
    expect(reporterHint('127.0.0.1', 7790)).toContain('LOUSHO_OBSERVE=http://127.0.0.1:7790');
    expect(reporterHint('127.0.0.1', 7790)).not.toContain('LOUSHO_OBSERVE=1');
    expect(reporterHint('localhost', 7777)).toContain('LOUSHO_OBSERVE=http://localhost:7777');
  });

  it('brackets an IPv6 host', () => {
    expect(reporterHint('::1', 7777)).toContain('LOUSHO_OBSERVE=http://[::1]:7777 ');
    expect(reporterHint('[::1]', 7790)).toContain('LOUSHO_OBSERVE=http://[::1]:7790 ');
  });
});

describe('lousho observe', () => {
  it('prints help (0 with --help, 2 with none) and exits 2 on an unknown command', async () => {
    expect(await runObserve([])).toBe(2);
    expect(logs.at(-1)).toContain('lousho observe');
    expect(await runObserve(['--help'])).toBe(0);
    expect(await runObserve(['bogus'])).toBe(2);
    expect(errors.at(-1)).toContain('unknown command');
  });

  it('status reports a running collector and its counts', async () => {
    const daemon = await start();
    expect(await runObserve(['status', '--url', `http://127.0.0.1:${daemon.port}`])).toBe(0);
    expect(logs.join('\n')).toContain('running at');
    expect(logs.join('\n')).toContain('0 agents');
  });

  it('status exits 1 when nothing answers', async () => {
    expect(await runObserve(['status', '--url', 'http://127.0.0.1:1'])).toBe(1);
    expect(errors.at(-1)).toContain('no collector');
  });

  it('start on the daemon\'s own port reports "already running" and exits 0', async () => {
    const daemon = await startObserveDaemon({ dbPath: dbPath(), port: 0 });
    daemons.push(daemon);
    expect(await runObserve(['start', '--port', String(daemon.port), '--db', dbPath()])).toBe(0);
    expect(logs.at(-1)).toContain('already running');
  });

  it('start on a port a different service owns exits 1 with an actionable error', async () => {
    const alien = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => alien.listen(0, '127.0.0.1', resolve));
    servers.push(alien);
    const port = (alien.address() as { port: number }).port;
    expect(await runObserve(['start', '--port', String(port), '--db', dbPath()])).toBe(1);
    expect(errors.at(-1)).toContain('taken by another service');
  });

  it('stop exits 1 without a pidfile and clears a stale one', async () => {
    const db = dbPath();
    expect(await runObserve(['stop', '--db', db])).toBe(1);
    expect(errors.at(-1)).toContain('no pidfile');
    const pidPath = defaultPidPath(db);
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, '99999999');
    expect(await runObserve(['stop', '--db', db])).toBe(0);
    expect(logs.at(-1)).toContain('already gone');
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('start --db b.db against a daemon serving a.db exits 1 naming the other db', async () => {
    const a = path.join(cwd, 'a.db');
    const daemon = await startObserveDaemon({ dbPath: a, port: 0 });
    daemons.push(daemon);
    expect(await runObserve(['start', '--port', String(daemon.port), '--db', path.join(cwd, 'b.db')])).toBe(1);
    expect(errors.at(-1)).toContain(`port ${daemon.port} is serving ${path.resolve(a)}`);
    // the same db is still "already running"
    expect(await runObserve(['start', '--port', String(daemon.port), '--db', a])).toBe(0);
    expect(logs.at(-1)).toContain('already running');
  });

  it('stop --db a.db does not signal a pid whose daemon serves b.db', async () => {
    const b = await startObserveDaemon({ dbPath: path.join(cwd, 'b.db'), port: 0 });
    daemons.push(b);
    const a = path.join(cwd, 'a.db');
    fs.writeFileSync(defaultPidPath(a), `${process.pid}\n${b.port}\n`);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runObserve(['stop', '--db', a])).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(errors.at(-1)).toContain('serves');
    expect(fs.existsSync(defaultPidPath(a))).toBe(true);
  });

  it('stop signals the pid when its daemon serves this db', async () => {
    const a = path.join(cwd, 'a.db');
    const d = await startObserveDaemon({ dbPath: a, port: 0, pidPath: defaultPidPath(a) });
    daemons.push(d);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await runObserve(['stop', '--db', a])).toBe(0);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('rebuild-rollups rebuilds the buckets of a local db', async () => {
    expect(await runObserve(['rebuild-rollups', '--db', dbPath()])).toBe(0);
    expect(logs.at(-1)).toContain('rebuilt');
  });

  it('token create prints the key once; a missing --project or verb is a usage error', async () => {
    const db = dbPath();
    expect(await runObserve(['token', 'create', '--project', 'smoke', '--db', db])).toBe(0);
    expect(logs.some((line) => line.includes('token created'))).toBe(true);
    expect(await runObserve(['token', 'create', '--db', db])).toBe(2);
    expect(await runObserve(['token', 'bogus', '--project', 'x', '--db', db])).toBe(2);
  });
  it('prune --older-than Nd deletes old finished runs, prints the three counts and keeps open ones', async () => {
    const file = dbPath();
    const db = openDb(file);
    const old = Date.now() - 40 * 86_400_000;
    ingestBatch(db, [
      { type: 'observation', data: { obs_id: 'o1', trace_id: 't1', kind: 'span', name: 'x', start: old, end: old + 5, status: 'ok' } },
      { type: 'observation', data: { obs_id: 'o2', trace_id: 't2', kind: 'span', name: 'x', start: old } },
    ]);
    db.close();
    expect(await runObserve(['prune', '--older-than', '30d', '--db', file])).toBe(0);
    expect(logs.join('\n')).toContain('pruned 1 observations, 0 scores, 0 sessions');
    const after = openDb(file);
    try {
      expect(after.prepare('SELECT obs_id FROM observations').all().map((r) => r.obs_id)).toEqual(['o2']);
    } finally {
      after.close();
    }
  });

  it('prune exits 0 with the counts when only the VACUUM after the committed prune fails', async () => {
    const file = dbPath();
    const db = openDb(file);
    const old = Date.now() - 40 * 86_400_000;
    ingestBatch(db, [{ type: 'observation', data: { obs_id: 'o1', trace_id: 't1', kind: 'span', name: 'x', start: old, end: old + 5, status: 'ok' } }]);
    db.close();
    const proto = loadDatabaseSync().prototype as SqlDatabase;
    const realExec = proto.exec;
    vi.spyOn(proto, 'exec').mockImplementation(function (this: SqlDatabase, sql: string) {
      if (/^\s*VACUUM/i.test(sql)) throw new Error('database is locked');
      return realExec.call(this, sql);
    });
    expect(await runObserve(['prune', '--older-than=30d', '--db', file])).toBe(0);
    expect(logs.join('\n')).toContain('pruned 1 observations, 0 scores, 0 sessions');
    expect(errors.at(-1)).toContain('pruned, but VACUUM failed: database is locked');
    vi.restoreAllMocks();
    const after = openDb(file);
    try {
      expect(after.prepare('SELECT COUNT(*) AS n FROM observations').get()?.n).toBe(0);
    } finally {
      after.close();
    }
  });

  it('prune is safe beside a running daemon on the same db file', async () => {
    const file = dbPath();
    const daemon = await startObserveDaemon({ dbPath: file, port: 0, sweepIntervalMs: 0, retentionDays: 0 });
    daemons.push(daemon);
    const old = Date.now() - 40 * 86_400_000;
    ingestBatch(daemon.db, [
      { type: 'observation', data: { obs_id: 'o1', trace_id: 't1', kind: 'span', name: 'x', start: old, end: old + 5, status: 'ok' } },
      { type: 'observation', data: { obs_id: 'o2', trace_id: 't2', kind: 'span', name: 'x', start: old } },
    ]);
    expect(await runObserve(['prune', '--older-than=30d', '--db', file])).toBe(0);
    expect(logs.join('\n')).toContain('pruned 1 observations');
    // the daemon's own connection sees the prune and keeps ingesting
    expect(daemon.db.prepare('SELECT obs_id FROM observations').all().map((r) => r.obs_id)).toEqual(['o2']);
    ingestBatch(daemon.db, [{ type: 'observation', data: { obs_id: 'o2', trace_id: 't2', kind: 'span', name: 'x', start: old, end: old + 9, status: 'ok' } }]);
    expect(daemon.db.prepare('SELECT "end" FROM observations WHERE obs_id = ?').get('o2')?.end).toBe(old + 9);
  });

  it('prune and start --retention-days reject junk as usage errors', async () => {
    const file = dbPath();
    expect(await runObserve(['prune', '--db', file])).toBe(2);
    for (const bad of ['30', '-1d', '1.5d', 'xd', '30h', '0d']) {
      expect(await runObserve(['prune', `--older-than=${bad}`, '--db', file])).toBe(2);
    }
    expect(errors.at(-1)).toContain('--older-than');
    for (const bad of ['-1', '1.5', 'x', '']) {
      expect(await runObserve(['start', `--retention-days=${bad}`, '--db', file, '--port', '0'])).toBe(2);
    }
    expect(errors.at(-1)).toContain('--retention-days');
    for (const bad of ['-1', '1.5', 'x', '', '30m']) {
      expect(await runObserve(['start', `--session-idle-minutes=${bad}`, '--db', file, '--port', '0'])).toBe(2);
    }
    expect(errors.at(-1)).toContain('--session-idle-minutes');
  });

  describe('export', () => {
    const seed = (file: string): void => {
      const db = openDb(file);
      const now = Date.now();
      ingestBatch(db, [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', name: 'Alpha' } },
        { type: 'observation', data: { obs_id: 'o1', trace_id: 't1', agent_id: 'a1', kind: 'span', name: 'root1', start: now - 3 * 3_600_000, end: now - 3 * 3_600_000 + 5, status: 'ok' } },
        { type: 'observation', data: { obs_id: 'o1c', trace_id: 't1', agent_id: 'a1', parent_obs_id: 'o1', kind: 'generation', name: 'llm', start: now - 3 * 3_600_000 + 1, end: now - 3 * 3_600_000 + 4, status: 'ok' } },
        { type: 'observation', data: { obs_id: 'o2', trace_id: 't2', agent_id: 'a2', kind: 'span', name: 'root2', start: now - 40 * 86_400_000, end: now - 40 * 86_400_000 + 5, status: 'ok' } },
        { type: 'observation', data: { obs_id: 'o3', trace_id: 't3', agent_id: 'a1', kind: 'span', name: 'root3', start: now - 1000, end: now - 990, status: 'ok' } },
      ]);
      db.close();
    };

    it('writes one parseable JSONL line per trace, oldest first, with nested observations and scores', async () => {
      const file = dbPath();
      seed(file);
      expect(await runObserve(['export', '--db', file])).toBe(0);
      const lines = logs.filter((l) => l.startsWith('{'));
      expect(lines).toHaveLength(3);
      const parsed = lines.map((l) => JSON.parse(l) as { trace: { trace_id: string }; observations: unknown[]; scores: unknown[] });
      expect(parsed.map((p) => p.trace.trace_id)).toEqual(['t2', 't1', 't3']);
      expect(parsed[1].observations).toHaveLength(2);
      expect(parsed[1].scores).toEqual([]);
      expect(logs.join('\n')).not.toContain('exported');
      expect(errors.join('\n')).toContain('exported 3 traces');
    });

    it('--since and --agent narrow the export (agent matches id or a unique name)', async () => {
      const file = dbPath();
      seed(file);
      expect(await runObserve(['export', '--since', '7d', '--agent', 'a1', '--db', file])).toBe(0);
      expect(logs.map((l) => (JSON.parse(l) as { trace: { trace_id: string } }).trace.trace_id)).toEqual(['t1', 't3']);
      logs.length = 0;
      expect(await runObserve(['export', '--since=2h', '--agent', 'Alpha', '--db', file])).toBe(0);
      expect(logs.map((l) => (JSON.parse(l) as { trace: { trace_id: string } }).trace.trace_id)).toEqual(['t3']);
    });

    it('--out writes the file and prints the count to stdout', async () => {
      const file = dbPath();
      seed(file);
      const out = path.join(cwd, 'dump.jsonl');
      expect(await runObserve(['export', '--out', out, '--db', file])).toBe(0);
      const text = fs.readFileSync(out, 'utf8');
      expect(text.trim().split('\n')).toHaveLength(3);
      expect(text.endsWith('\n')).toBe(true);
      expect(logs.join('\n')).toContain('exported 3 traces');
    });

    it('pages past the 500-trace page size and rejects a bad --since', async () => {
      const file = dbPath();
      const db = openDb(file);
      const now = Date.now();
      ingestBatch(
        db,
        Array.from({ length: 520 }, (_, i) => ({
          type: 'observation' as const,
          data: { obs_id: `o${i}`, trace_id: `t${i}`, kind: 'span', name: 'x', start: now - 1000 + i, end: now - 1000 + i + 1, status: 'ok' },
        }))
      );
      db.close();
      expect(await runObserve(['export', '--db', file])).toBe(0);
      expect(logs).toHaveLength(520);
      for (const bad of ['7', '0d', '-1d', 'xd', '1.5h']) {
        expect(await runObserve(['export', `--since=${bad}`, '--db', file])).toBe(2);
      }
      expect(errors.at(-1)).toContain('--since');
    });
  });
});
