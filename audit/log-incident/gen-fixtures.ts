/**
 * Deterministic fixture generator for the incident-triage scenario.
 *
 * Story (all times UTC, 2026-09-30):
 *  13:30  normal traffic, 4 api pods, pg max_connections=100
 *  13:44  red herring: a bot scans /wp-login.php etc. (404 burst)
 *  13:51  red herring: slow analytics query on reports (unrelated)
 *  14:02:13 deploy of api v2.41.0 (commit 9f3c2e1) - checkout handler leaks a
 *         pooled pg client on the coupon-validation error path
 *  14:02-14:09 pool "in use" climbs, waitingCount appears
 *  14:09  HPA scales api 4 -> 8 pods because of latency; new pods open more conns
 *  14:10:40 first "timeout exceeded when trying to connect" on checkout
 *  14:11  postgres "sorry, too many clients already" - 502/504 spike on DB routes
 *  14:24  on-call restarts pods (brief relief, then it re-leaks)
 *  14:38:05 rollback to v2.40.3, 14:41 recovered
 *  /healthz and static assets stay 200 the whole time.
 *
 * Run: npx tsx log-incident/gen-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(OUT, { recursive: true });

// mulberry32
let seed = 0x5eed1234;
function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');

const DAY = Date.UTC(2026, 8, 30); // 2026-09-30
const T = (hh: number, mm: number, ss = 0, ms = 0) => DAY + ((hh * 60 + mm) * 60 + ss) * 1000 + ms;
const START = T(13, 30);
const END = T(15, 0);
const DEPLOY = T(14, 2, 13);
const HPA = T(14, 9, 2);
const FIRST_TIMEOUT = T(14, 10, 40);
const PG_FULL = T(14, 11, 0);
const RESTART = T(14, 24, 10);
const RELEAK = T(14, 29, 30);
const ROLLBACK = T(14, 38, 5);
const RECOVERED = T(14, 41, 0);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
function nginxTime(ms: number) {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}
const iso = (ms: number) => new Date(ms).toISOString();
function pgTime(ms: number) {
  return iso(ms).replace('T', ' ').replace('Z', ' UTC');
}

type Line = { t: number; s: string };
const nginx: Line[] = [];
const app: Line[] = [];
const pg: Line[] = [];

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  'shop-android/5.12.1 okhttp/4.12.0',
  'kube-probe/1.31',
];
const ROUTES: { path: () => string; w: number; db: boolean; method: string }[] = [
  { path: () => `/api/products?page=${int(1, 9)}`, w: 30, db: true, method: 'GET' },
  { path: () => `/api/products/${int(1000, 9999)}`, w: 20, db: true, method: 'GET' },
  { path: () => '/api/cart', w: 12, db: true, method: 'GET' },
  { path: () => '/api/checkout', w: 6, db: true, method: 'POST' },
  { path: () => `/api/orders/${int(50000, 99999)}`, w: 6, db: true, method: 'GET' },
  { path: () => '/api/search?q=' + pick(['shoes', 'jacket', 'lamp', 'mug', 'desk']), w: 8, db: false, method: 'GET' },
  { path: () => `/static/js/app.${pick(['4f1a', '9c2e'])}.js`, w: 10, db: false, method: 'GET' },
  { path: () => `/static/img/p${int(1, 400)}.webp`, w: 12, db: false, method: 'GET' },
];
const totalW = ROUTES.reduce((a, r) => a + r.w, 0);
function pickRoute() {
  let x = rnd() * totalW;
  for (const r of ROUTES) if ((x -= r.w) < 0) return r;
  return ROUTES[0];
}
const PODS_OLD = ['api-6d8b9-k2xq', 'api-6d8b9-p7mm', 'api-6d8b9-r4tz', 'api-6d8b9-w9cv'];
const PODS_NEW = ['api-7f4c1-a1bd', 'api-7f4c1-c3ef', 'api-7f4c1-g5hj', 'api-7f4c1-k7lm'];
const PODS_HPA = ['api-7f4c1-n2pq', 'api-7f4c1-s4tu', 'api-7f4c1-v6wx', 'api-7f4c1-y8za'];
const PODS_RB = ['api-6d8b9-b3cd', 'api-6d8b9-f5gh', 'api-6d8b9-j7kl', 'api-6d8b9-m9no'];
function podsAt(t: number) {
  if (t < DEPLOY + 40_000) return PODS_OLD;
  if (t >= ROLLBACK + 45_000) return PODS_RB;
  if (t >= HPA + 30_000) return [...PODS_NEW, ...PODS_HPA];
  return PODS_NEW;
}
const upstreamIp = (pod: string) => `10.1.${(pod.charCodeAt(pod.length - 1) % 8) + 1}.${(pod.charCodeAt(pod.length - 2) % 200) + 10}`;

/** 0..1 how degraded DB-backed routes are at time t. */
function degradation(t: number): number {
  if (t < FIRST_TIMEOUT) return 0;
  if (t < PG_FULL) return 0.15;
  if (t < RESTART) return Math.min(0.85, 0.45 + (t - PG_FULL) / (10 * 60_000) * 0.4);
  if (t < RESTART + 60_000) return 0.3; // pods restarting
  if (t < RELEAK) return 0.03; // brief relief
  if (t < ROLLBACK) return Math.min(0.8, 0.2 + (t - RELEAK) / (6 * 60_000) * 0.6);
  if (t < RECOVERED) return 0.4 * (1 - (t - ROLLBACK) / (RECOVERED - ROLLBACK));
  return 0;
}

// ---- traffic ----
for (let minute = START; minute < END; minute += 60_000) {
  const rpm = int(210, 290);
  for (let i = 0; i < rpm; i++) {
    const t = minute + Math.floor(rnd() * 60_000);
    const route = pickRoute();
    const path = route.path();
    const pods = podsAt(t);
    const pod = pick(pods);
    const reqId = hex(16);
    const ip = `${pick(['81.2', '94.130', '176.9', '5.161', '37.44'])}.${int(1, 254)}.${int(1, 254)}`;
    const ua = pick(UAS.slice(0, 4));
    let status = rnd() < 0.004 ? 500 : route.method === 'POST' && rnd() < 0.03 ? 422 : 200;
    if (path.startsWith('/api/products/') && rnd() < 0.02) status = 404;
    let rt = route.db ? 0.02 + rnd() * 0.12 : 0.001 + rnd() * 0.01;
    const d = route.db ? degradation(t) : 0;
    // after deploy and before hard failure: latency creeps up on db routes
    if (route.db && t > DEPLOY + 60_000 && t < ROLLBACK) rt += Math.min(1.5, (t - DEPLOY) / (8 * 60_000)) * rnd();
    let appMsg: string | null = null;
    if (route.db && rnd() < d) {
      if (rnd() < 0.6) {
        status = 504;
        rt = 30 + rnd() * 0.05;
        appMsg = 'timeout exceeded when trying to connect';
      } else {
        status = 502;
        rt = 0.2 + rnd() * 2;
        appMsg = t >= PG_FULL ? 'sorry, too many clients already' : 'timeout exceeded when trying to connect';
      }
    }
    const isStatic = path.startsWith('/static');
    const bytes = status >= 500 ? int(150, 600) : isStatic ? int(8000, 220000) : int(400, 9000);
    const up = isStatic ? '-' : `${upstreamIp(pod)}:3000`;
    nginx.push({
      t,
      s: `${ip} - - [${nginxTime(t)}] "${route.method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}" rt=${rt.toFixed(3)} upstream=${up} req_id=${reqId}`,
    });
    if (!isStatic) {
      const tApp = t + Math.floor(rt * 1000) - 1;
      const route0 = path.split('?')[0].replace(/\/\d+$/, '/:id');
      if (appMsg) {
        app.push({
          t: tApp,
          s: JSON.stringify({
            ts: iso(tApp), level: 'error', pod, req_id: reqId, route: route0, msg: 'db query failed',
            err: { name: 'Error', message: appMsg, code: appMsg.startsWith('sorry') ? '53300' : undefined },
          }),
        });
      }
      if (rnd() < 0.45 || appMsg) {
        app.push({ t: tApp, s: JSON.stringify({ ts: iso(tApp), level: status >= 500 ? 'warn' : 'info', pod, req_id: reqId, msg: 'request completed', route: route0, method: route.method, status, duration_ms: Math.round(rt * 1000) }) });
      }
      // the leak: coupon validation error path on checkout in v2.41.0
      if (path === '/api/checkout' && t > DEPLOY + 40_000 && t < ROLLBACK + 45_000 && rnd() < 0.35 && !appMsg) {
        app.push({ t: tApp - 3, s: JSON.stringify({ ts: iso(tApp - 3), level: 'warn', pod, req_id: reqId, route: '/api/checkout', msg: 'coupon validation failed', coupon: pick(['FALL10', 'WELCOME5', 'VIP20', 'EXPIRED22']), reason: pick(['expired', 'not_found', 'min_total_not_met']) }) });
      }
    }
  }
  // kube probes: always 200 (classic: healthz does not touch the db)
  for (const pod of podsAt(minute)) {
    for (const off of [5_000, 35_000]) {
      const t = minute + off + int(0, 900);
      nginx.push({ t, s: `10.0.0.${int(2, 9)} - - [${nginxTime(t)}] "GET /healthz HTTP/1.1" 200 15 "-" "kube-probe/1.31" rt=0.001 upstream=${upstreamIp(pod)}:3000 req_id=${hex(16)}` });
    }
  }
}

// ---- red herring 1: bot scan at 13:44 ----
for (let i = 0; i < 180; i++) {
  const t = T(13, 44, 0) + int(0, 110_000);
  const path = pick(['/wp-login.php', '/.env', '/admin/config.php', '/xmlrpc.php', '/.git/config', '/phpmyadmin/']);
  nginx.push({ t, s: `45.155.205.${int(1, 50)} - - [${nginxTime(t)}] "GET ${path} HTTP/1.1" 404 153 "-" "Mozilla/5.0 zgrab/0.x" rt=0.000 upstream=- req_id=${hex(16)}` });
}

// ---- app lifecycle + pool stats ----
function appLog(t: number, o: Record<string, unknown>) {
  app.push({ t, s: JSON.stringify({ ts: iso(t), ...o }) });
}
for (const pod of PODS_OLD) appLog(START + int(0, 2000), { level: 'info', pod, msg: 'server listening', version: 'v2.40.3', commit: 'c41d7a0', port: 3000, pool: { max: 20 } });
appLog(DEPLOY, { level: 'info', pod: 'deployer', msg: 'deploy started', service: 'api', version: 'v2.41.0', commit: '9f3c2e1', previous: 'v2.40.3', author: 'j.alvarez', change: 'checkout: validate coupons before reserving stock (#2231)' });
PODS_NEW.forEach((pod, i) => appLog(DEPLOY + 18_000 + i * 6_000, { level: 'info', pod, msg: 'server listening', version: 'v2.41.0', commit: '9f3c2e1', port: 3000, pool: { max: 20 } }));
appLog(DEPLOY + 47_000, { level: 'info', pod: 'deployer', msg: 'deploy finished', service: 'api', version: 'v2.41.0', replicas: 4 });
appLog(HPA, { level: 'info', pod: 'hpa-controller', msg: 'scaled deployment', deployment: 'api', from: 4, to: 8, reason: 'p95 latency above target (1200ms > 800ms)' });
PODS_HPA.forEach((pod, i) => appLog(HPA + 20_000 + i * 4_000, { level: 'info', pod, msg: 'server listening', version: 'v2.41.0', commit: '9f3c2e1', port: 3000, pool: { max: 20 } }));
appLog(RESTART, { level: 'warn', pod: 'oncall', msg: 'rolling restart requested', deployment: 'api', by: 'm.chen', note: 'mitigation attempt' });
appLog(ROLLBACK, { level: 'warn', pod: 'deployer', msg: 'rollback started', service: 'api', from: 'v2.41.0', to: 'v2.40.3', by: 'm.chen' });
PODS_RB.forEach((pod, i) => appLog(ROLLBACK + 30_000 + i * 5_000, { level: 'info', pod, msg: 'server listening', version: 'v2.40.3', commit: 'c41d7a0', port: 3000, pool: { max: 20 } }));
appLog(ROLLBACK + 70_000, { level: 'info', pod: 'deployer', msg: 'rollback finished', service: 'api', version: 'v2.40.3', replicas: 4 });
appLog(T(14, 7, 20), { level: 'info', pod: 'scheduler', msg: 'cache warmup finished', keys: 18233 }); // noise

// pool stats every 30 s per pod
for (let t = START; t < END; t += 30_000) {
  for (const pod of podsAt(t)) {
    const leaky = pod.includes('7f4c1');
    let total: number, idle: number, waiting = 0;
    if (!leaky) {
      total = int(4, 9);
      idle = int(1, total - 1);
    } else {
      // pods leak ~1.3 clients/min; after restart counters reset
      const born = t < RESTART + 40_000 ? (PODS_HPA.includes(pod) ? HPA + 30_000 : DEPLOY + 40_000) : RESTART + 40_000;
      const leaked = Math.max(0, Math.floor((t - born) / 60_000 * 1.6 + rnd()));
      let cap = 20;
      if (t >= PG_FULL && t < RESTART) cap = int(9, 14); // db refuses new connections
      total = Math.min(cap, leaked + int(3, 6));
      idle = Math.max(0, total - leaked - int(2, 4));
      waiting = total >= cap ? int(5, 40) : 0;
    }
    appLog(t + int(0, 800), { level: waiting > 0 ? 'warn' : 'debug', pod, msg: 'pg pool stats', totalCount: total, idleCount: idle, waitingCount: waiting });
  }
}

// ---- postgres ----
function pgLog(t: number, pid: number, user: string, sev: string, msg: string) {
  pg.push({ t, s: `${pgTime(t)} [${pid}] ${user} ${sev}:  ${msg}` });
}
pgLog(START + 1000, 4122, '', 'LOG', 'checkpoint starting: time');
for (let t = START; t < END; t += 60_000) {
  // routine
  pgLog(t + int(0, 59_000), int(20000, 60000), 'app@shop', 'LOG', `duration: ${(rnd() * 40 + 2).toFixed(3)} ms  statement: SELECT p.id, p.name, p.price FROM products p WHERE p.category_id = $1 LIMIT 24`);
  if (rnd() < 0.5) pgLog(t + int(0, 59_000), 4122, '', 'LOG', `checkpoint complete: wrote ${int(80, 900)} buffers (${(rnd() * 3).toFixed(1)}%); 0 WAL file(s) added, 0 removed, 1 recycled`);
  pgLog(t + int(0, 59_000), int(20000, 60000), 'app@shop', 'LOG', 'connection authorized: user=app database=shop application_name=api');
  const d = degradation(t + 30_000);
  if (t >= PG_FULL - 60_000 && d > 0.1) {
    const n = Math.round(d * 60);
    for (let i = 0; i < n; i++) {
      const tt = t + int(0, 59_999);
      pgLog(tt, int(60000, 70000), 'app@shop', 'FATAL', rnd() < 0.7 ? 'sorry, too many clients already' : 'remaining connection slots are reserved for non-replication superuser connections');
    }
    // idle in transaction connections (the leak's footprint)
    if (rnd() < 0.6) pgLog(t + int(0, 59_999), int(20000, 60000), 'app@shop', 'LOG', `process ${int(20000, 60000)} still waiting for ShareLock on transaction ${int(880000, 890000)} after 1000.112 ms`);
  }
  if (t >= DEPLOY && t < ROLLBACK && rnd() < 0.5) {
    pgLog(t + int(0, 59_999), int(20000, 60000), 'app@shop', 'LOG', `connection stats: ${Math.min(100, 30 + Math.floor((t - DEPLOY) / 60_000) * 4)} of max_connections=100 in use, ${Math.min(70, Math.floor((t - DEPLOY) / 60_000) * 3)} idle in transaction`);
  }
}
// red herring 2: slow analytics query
pgLog(T(13, 51, 12), 51234, 'analytics@shop', 'LOG', 'duration: 8412.551 ms  statement: SELECT date_trunc(\'day\', created_at), sum(total) FROM orders GROUP BY 1 ORDER BY 1');
pgLog(T(13, 51, 13), 51234, 'analytics@shop', 'WARNING', 'temporary file: path "base/pgsql_tmp/pgsql_tmp51234.0", size 214958080');
pgLog(T(14, 26, 0), 1, '', 'LOG', 'terminating idle connections after api restart: 63 connections closed');
pgLog(T(14, 39, 40), 1, '', 'LOG', 'terminating idle connections after api restart: 81 connections closed');
pgLog(PG_FULL + 2_000, 6012, 'app@shop', 'FATAL', 'sorry, too many clients already');

for (const [name, lines] of [['nginx-access.log', nginx], ['app.jsonl', app], ['postgres.log', pg]] as const) {
  lines.sort((a, b) => a.t - b.t);
  writeFileSync(join(OUT, name), lines.map((l) => l.s).join('\n') + '\n');
  console.log(name, lines.length, 'lines');
}
console.log('total', nginx.length + app.length + pg.length);
