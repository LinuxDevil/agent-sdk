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
import { runObserve } from './observe';

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
    fs.writeFileSync(defaultPidPath(a), `${process.pid}
${b.port}
`);
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
});
