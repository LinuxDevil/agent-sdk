/**
 * Log store + the three triage tools. Logs are parsed once into memory with a
 * normalised epoch-ms timestamp so every tool can filter by time window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export type Source = 'nginx' | 'app' | 'postgres';
export interface LogLine { source: Source; t: number; raw: string }

const MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseTs(source: Source, raw: string): number {
  if (source === 'nginx') {
    const m = /\[(\d\d)\/(\w{3})\/(\d{4}):(\d\d):(\d\d):(\d\d)/.exec(raw);
    return m ? Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) : NaN;
  }
  if (source === 'app') return Date.parse(JSON.parse(raw).ts);
  return Date.parse(raw.slice(0, 23).replace(' ', 'T') + 'Z');
}

let cache: LogLine[] | undefined;
export function loadLogs(): LogLine[] {
  if (cache) return cache;
  if (!existsSync(join(FIXTURES, 'app.jsonl'))) throw new Error('fixtures missing: run `npx tsx log-incident/gen-fixtures.ts`');
  const files: [Source, string][] = [['nginx', 'nginx-access.log'], ['app', 'app.jsonl'], ['postgres', 'postgres.log']];
  cache = files.flatMap(([source, f]) =>
    readFileSync(join(FIXTURES, f), 'utf8').split('\n').filter(Boolean).map((raw) => ({ source, raw, t: parseTs(source, raw) }))
  );
  cache.sort((a, b) => a.t - b.t);
  return cache;
}

const DAY = '2026-09-30';
/** Accepts "14:02", "14:02:13", or a full ISO timestamp. */
export function parseWhen(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const hm = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/.exec(s.trim());
  if (hm) return Date.parse(`${DAY}T${hm[1].padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}Z`);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`cannot parse time "${s}" - use HH:MM, HH:MM:SS or ISO 8601`);
  return t;
}

/** Hook so scenarios can observe/inject behaviour on every tool execution. */
export const toolTap: { onCall?: (name: string, args: unknown, ctx: { toolCallId?: string; abortSignal?: AbortSignal }) => Promise<void> | void; delayMs?: number } = {};

async function tap(name: string, args: unknown, ctx: { toolCallId?: string; abortSignal?: AbortSignal }) {
  await toolTap.onCall?.(name, args, ctx);
  if (toolTap.delayMs) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, toolTap.delayMs);
      ctx.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); reject(ctx.abortSignal!.reason ?? new Error('aborted')); }, { once: true });
    });
  }
}

const sourceEnum = z.enum(['nginx', 'app', 'postgres', 'all']);
/** Lines are clipped so one tool result cannot blow the 8K local context. */
export const MAX_LINE = Number(process.env.MAX_LINE ?? 260);
const fmt = (l: LogLine) => { const s = `[${l.source}] ${l.raw}`; return s.length > MAX_LINE ? s.slice(0, MAX_LINE) + '�' : s; };

export const searchLogs = defineTool({
  name: 'search_logs',
  description:
    'Search the incident logs (nginx access log, app JSON log, postgres log) for a case-insensitive regex, optionally within a time window. Returns the total match count, per-source counts and the first `limit` matching lines.',
  input: z.object({
    pattern: z.string().describe('Case-insensitive JavaScript regex, e.g. "too many clients" or "\\" 50[0-9] "'),
    source: sourceEnum.default('all'),
    from: z.string().optional().describe('Start time, HH:MM[:SS] (UTC, 2026-09-30) or ISO'),
    to: z.string().optional().describe('End time, HH:MM[:SS] or ISO'),
    limit: z.number().int().min(1).max(30).default(15).describe('max lines returned (keep small: the context window is 8K tokens)'),
  }),
  execute: async ({ pattern, source, from, to, limit }, ctx) => {
    await tap('search_logs', { pattern, source, from, to, limit }, ctx);
    const logs = loadLogs();
    const lo = parseWhen(from, -Infinity), hi = parseWhen(to, Infinity);
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const hits = logs.filter((l) => (source === 'all' || l.source === source) && l.t >= lo && l.t <= hi && re.test(l.raw));
    const bySource: Record<string, number> = {};
    for (const h of hits) bySource[h.source] = (bySource[h.source] ?? 0) + 1;
    return {
      total: hits.length,
      bySource,
      firstAt: hits[0] ? new Date(hits[0].t).toISOString() : null,
      lastAt: hits.at(-1) ? new Date(hits.at(-1)!.t).toISOString() : null,
      lines: hits.slice(0, limit).map(fmt),
    };
  },
});

export const statusPerMinute = defineTool({
  name: 'status_per_minute',
  description:
    'Aggregate nginx HTTP status classes per minute (2xx/3xx/4xx/5xx and total) in a time window, optionally only for request paths starting with `pathPrefix`. Use it to find when errors started and stopped.',
  input: z.object({
    from: z.string().describe('Start time, HH:MM[:SS] or ISO'),
    to: z.string().describe('End time, HH:MM[:SS] or ISO'),
    pathPrefix: z.string().optional().describe('e.g. "/api/checkout"'),
  }),
  execute: async ({ from, to, pathPrefix }, ctx) => {
    await tap('status_per_minute', { from, to, pathPrefix }, ctx);
    const lo = parseWhen(from, -Infinity), hi = parseWhen(to, Infinity);
    const rows = new Map<number, { total: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number }>();
    for (const l of loadLogs()) {
      if (l.source !== 'nginx' || l.t < lo || l.t > hi) continue;
      const m = /"\w+ (\S+) HTTP\/[\d.]+" (\d{3})/.exec(l.raw);
      if (!m || (pathPrefix && !m[1].startsWith(pathPrefix))) continue;
      const minute = Math.floor(l.t / 60_000) * 60_000;
      const r = rows.get(minute) ?? { total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
      r.total++;
      (r as Record<string, number>)[`s${m[2][0]}xx`]++;
      rows.set(minute, r);
    }
    // compact text table: one row per minute
    return ['minute total 2xx 3xx 4xx 5xx', ...[...rows.entries()].sort((a, b) => a[0] - b[0]).map(([m, r]) => `${new Date(m).toISOString().slice(11, 16)} ${r.total} ${r.s2xx} ${r.s3xx} ${r.s4xx} ${r.s5xx}`)].join('\n');
  },
});

export const logsAround = defineTool({
  name: 'logs_around',
  description:
    'Fetch log lines from all sources (or one) within +/- `windowSeconds` of a timestamp, in time order. Good for reading what happened right at a deploy or the first error.',
  input: z.object({
    timestamp: z.string().describe('HH:MM[:SS] or ISO'),
    windowSeconds: z.number().int().min(1).max(600).default(30),
    source: sourceEnum.default('all'),
    excludePattern: z.string().optional().describe('Regex of lines to drop, e.g. "request completed|healthz"'),
    limit: z.number().int().min(1).max(30).default(25),
  }),
  execute: async ({ timestamp, windowSeconds, source, excludePattern, limit }, ctx) => {
    await tap('logs_around', { timestamp, windowSeconds, source, excludePattern, limit }, ctx);
    const t = parseWhen(timestamp, NaN);
    const ex = excludePattern ? new RegExp(excludePattern, 'i') : undefined;
    const lines = loadLogs().filter(
      (l) => (source === 'all' || l.source === source) && Math.abs(l.t - t) <= windowSeconds * 1000 && !(ex && ex.test(l.raw))
    );
    return { total: lines.length, truncated: lines.length > limit, lines: lines.slice(0, limit).map(fmt) };
  },
});

export const tools = [searchLogs, statusPerMinute, logsAround];

export const IncidentReport = z.object({
  title: z.string(),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
  impactStart: z.string().describe('ISO time the user impact started'),
  impactEnd: z.string().describe('ISO time the user impact ended'),
  timeline: z.array(z.object({ time: z.string(), event: z.string() })).min(3),
  rootCause: z.string(),
  trigger: z.string().describe('The change that triggered the incident (deploy, config, traffic...)'),
  blastRadius: z.object({
    affectedEndpoints: z.array(z.string()),
    unaffected: z.array(z.string()),
    peak5xxPerMinute: z.number(),
  }),
  evidence: z.array(z.object({ source: z.enum(['nginx', 'app', 'postgres']), line: z.string() })).min(2),
  remediation: z.array(z.string()).min(1),
});
export type IncidentReport = z.infer<typeof IncidentReport>;

/** Ground-truth grading of a report (the fixture story). */
export function grade(r: IncidentReport) {
  const all = JSON.stringify(r).toLowerCase();
  const checks = {
    deployVersion: all.includes('v2.41.0'),
    deployTime: /14:02/.test(all),
    poolOrLeak: /pool|leak/.test(all),
    tooManyClients: /too many clients|max_connections|connection slots/.test(all),
    checkoutAffected: r.blastRadius.affectedEndpoints.some((e) => e.includes('checkout')),
    rollback: /rollback|roll back|v2\.40\.3/.test(all),
    healthzNotBlamed: !r.blastRadius.affectedEndpoints.some((e) => e.includes('healthz')),
  };
  return { score: Object.values(checks).filter(Boolean).length, of: Object.keys(checks).length, checks };
}

export const INSTRUCTIONS = `You are an SRE on call. A production outage of the "shop" API happened on 2026-09-30 between 13:30 and 15:00 UTC.
You have three log sources: nginx access log, the api's JSON app log (deploys, pool stats, errors) and the postgres log.
Investigate with the tools: find when 5xx errors started and ended (status_per_minute), what changed right before (search for deploys / scaling events), and what the errors say (app and postgres errors).
Ignore unrelated noise. Quote real log lines as evidence (copy them exactly from tool output). Times are UTC.
Be efficient: at most 8 tool calls. Call independent tools in parallel when you can.`;

/** The local LM Studio model is loaded with an 8K context. */
export const LOCAL_CONTEXT_WINDOW = Number(process.env.LOCAL_CTX ?? 8192);
