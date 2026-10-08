/**
 * hostinger-monitor: a VPS/service health watchdog built on the packed
 * @lousho/build-ai-agent SDK.
 *
 * Monitored catalog: real HTTP endpoints plus (conditionally, when a
 * HOSTINGER_API_TOKEN is available) the live Hostinger VPS API. Incidents
 * are durable in `.runs/incidents.json`; agent sessions/checkpoints are
 * durable in a SqliteStore under `.runs/monitor.db`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, defineTool, defineSchedule, type AgentEvent } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../_shared/env.ts';
import { readHostingerToken } from './token.ts';

export const here = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = join(here, '.runs');
export const DB_PATH = join(RUNS_DIR, 'monitor.db');
export const INCIDENTS_FILE = join(RUNS_DIR, 'incidents.json');
export const CHECKS_LOG = join(RUNS_DIR, 'checks.jsonl');
export const SESSION_ID = 'monitor-main';
mkdirSync(RUNS_DIR, { recursive: true });

/* ---------------------------------------------------------------- catalog */

export interface MonitoredTarget {
  name: string;
  url: string;
  kind: 'http' | 'hostinger';
  /** HTTP status that means "healthy". */
  expect: number;
  note?: string;
}

/**
 * A Hostinger token is taken from the environment when the audit .env
 * provides one, else from ~/.claude.json (readHostingerToken) — the token
 * is used in an Authorization header only and is never printed or stored.
 */
export function hostingerToken(): string | undefined {
  if (process.env.HOSTINGER_API_TOKEN) return process.env.HOSTINGER_API_TOKEN;
  try {
    return readHostingerToken(); // reads ~/.claude.json; throws when absent
  } catch {
    return undefined;
  }
}

export function catalog(token: string | undefined): MonitoredTarget[] {
  const targets: MonitoredTarget[] = [
    { name: 'lousho-docs', url: 'https://lousho.com/introduction', kind: 'http', expect: 200, note: 'product docs site' },
    { name: 'openrouter-models', url: 'https://openrouter.ai/api/v1/models', kind: 'http', expect: 200, note: 'LLM gateway catalog' },
    {
      name: 'lousho-missing-page',
      url: 'https://lousho.com/this-page-does-not-exist-audit',
      kind: 'http',
      expect: 200,
      note: 'reachable host, wrong status -> degraded noise, NOT an incident',
    },
    { name: 'dead-vps-sim', url: 'http://127.0.0.1:9/', kind: 'http', expect: 200, note: 'discard port, always down' },
  ];
  if (token) {
    targets.push({
      name: 'hostinger-vps-api',
      url: 'https://developers.hostinger.com/api/vps/v1/virtual-machines',
      kind: 'hostinger',
      expect: 200,
      note: 'Hostinger control-plane VPS list (GET, read-only)',
    });
  }
  return targets;
}

/* --------------------------------------------------------- health checks */

export interface CheckResult {
  name: string;
  url: string;
  kind: 'http' | 'hostinger';
  ok: boolean;
  /** hard = unreachable or HTTP >= 500: incident-worthy. */
  hard: boolean;
  status?: number;
  latencyMs: number;
  detail: string;
  at: string;
}

/** Latest check per target name; the open_incident guard reads this. */
export const lastChecks = new Map<string, CheckResult>();

export async function checkEndpoint(target: MonitoredTarget, token?: string): Promise<CheckResult> {
  const t0 = Date.now();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (target.kind === 'hostinger' && token) headers.authorization = `Bearer ${token}`;
  let result: CheckResult;
  try {
    const res = await fetch(target.url, { headers, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const ok = res.status === target.expect;
    const hard = res.status >= 500;
    result = {
      name: target.name,
      url: target.url,
      kind: target.kind,
      ok,
      hard,
      status: res.status,
      latencyMs: Date.now() - t0,
      detail: ok ? `HTTP ${res.status} as expected` : `HTTP ${res.status}, expected ${target.expect}`,
      at: new Date().toISOString(),
    };
    await res.arrayBuffer().catch(() => {}); // drain
  } catch (error) {
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    result = {
      name: target.name,
      url: target.url,
      kind: target.kind,
      ok: false,
      hard: true,
      latencyMs: Date.now() - t0,
      detail: `unreachable: ${msg}`.slice(0, 300),
      at: new Date().toISOString(),
    };
  }
  lastChecks.set(target.name, result);
  appendFileSync(CHECKS_LOG, JSON.stringify(result) + '\n');
  return result;
}

/* ------------------------------------------------------------ incidents */

export interface Incident {
  id: string;
  endpoint: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
  status: 'open' | 'resolved';
  openedAt: string;
}

export function readIncidents(): Incident[] {
  if (!existsSync(INCIDENTS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(INCIDENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Incident[]) : [];
  } catch {
    return [];
  }
}

function writeIncidents(incidents: Incident[]): void {
  const tmp = `${INCIDENTS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(incidents, null, 2));
  renameSync(tmp, INCIDENTS_FILE); // atomic, same pattern as the SDK's fileStore
}

export type OpenAttempt =
  | { opened: true; incident: Incident }
  | { opened: false; reason: string; existingId?: string };

/**
 * The escalation floor, enforced in the tool itself: an incident may only be
 * opened for a target whose LAST check was a hard failure (unreachable or
 * HTTP >= 500). Healthy / degraded (4xx, wrong status) checks are refused,
 * and a target with an open incident dedupes instead of doubling up.
 */
export function attemptOpenIncident(endpoint: string, severity: Incident['severity'], summary: string): OpenAttempt {
  const incidents = readIncidents();
  const existing = incidents.find((i) => i.endpoint === endpoint && i.status === 'open');
  if (existing) return { opened: false, reason: `an incident is already open for '${endpoint}'`, existingId: existing.id };
  const check = lastChecks.get(endpoint);
  if (!check) return { opened: false, reason: `no check has run for '${endpoint}' yet — run check_endpoint first` };
  if (!check.hard) {
    return {
      opened: false,
      reason: `refused: '${endpoint}' last check was not a hard failure (${check.detail}). Degraded responses are noise, not incidents.`,
    };
  }
  const incident: Incident = {
    id: `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    endpoint,
    severity,
    summary,
    status: 'open',
    openedAt: new Date().toISOString(),
  };
  writeIncidents([...incidents, incident]);
  return { opened: true, incident };
}

/* ---------------------------------------------------------------- tools */

export function buildTools(targets: MonitoredTarget[], token: string | undefined) {
  const listMonitored = defineTool({
    name: 'list_monitored',
    description: 'List every monitored target: its name, URL, kind and expected HTTP status.',
    input: z.object({}),
    execute: () => targets.map(({ name, url, kind, expect, note }) => ({ name, url, kind, expect, note })),
  });

  const checkEndpointTool = defineTool({
    name: 'check_endpoint',
    description:
      'Run a live health check against one monitored target (by name from list_monitored). ' +
      'Returns ok, whether the failure is hard (unreachable or HTTP>=500), status, latency and detail.',
    input: z.object({ name: z.string().describe('target name from list_monitored') }),
    execute: async ({ name }) => {
      const target = targets.find((t) => t.name === name);
      if (!target) return { error: `unknown target '${name}'; call list_monitored for valid names` };
      return checkEndpoint(target, token);
    },
  });

  const listIncidents = defineTool({
    name: 'list_incidents',
    description: 'List incidents already recorded in the durable incident log (open and resolved).',
    input: z.object({}),
    execute: () => readIncidents(),
  });

  const openIncident = defineTool({
    name: 'open_incident',
    description:
      'Open a durable incident record for a target. Only accepted when the target\'s last check ' +
      'was a hard failure (unreachable or HTTP>=500); refused for healthy/degraded targets and ' +
      'deduplicated when an incident is already open.',
    input: z.object({
      endpoint: z.string().describe('target name from list_monitored'),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      summary: z.string().describe('one-line factual summary of the failure'),
    }),
    execute: ({ endpoint, severity, summary }) => attemptOpenIncident(endpoint, severity, summary),
  });

  const currentTime = defineTool({
    name: 'current_time',
    description: 'Current UTC time (ISO 8601).',
    input: z.object({}),
    execute: () => new Date().toISOString(),
  });

  return [listMonitored, checkEndpointTool, listIncidents, openIncident, currentTime];
}

/* ------------------------------------------------------- output + agent */

/** The structured incident report every tick ends with. */
export const IncidentReport = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'none']).describe('worst severity across all targets this tick'),
  affected: z.array(z.string()).describe('names of targets that are not fully healthy'),
  summary: z.string().describe('one or two sentences: what is broken, what is fine'),
  recommended_action: z.string().describe('the single most useful next step for an operator'),
  confidence: z.number().min(0).max(1).describe('confidence in this assessment'),
});
export type IncidentReport = z.infer<typeof IncidentReport>;

/** Harness-side escalation floor on top of the structured report. */
export function escalates(r: IncidentReport): boolean {
  return (r.severity === 'critical' || r.severity === 'high') && r.confidence >= 0.7;
}

export const INSTRUCTIONS = `You are the on-call watchdog for a small VPS/service fleet. On every health tick:

1. Call list_monitored, then check_endpoint once for EVERY target name, and list_incidents.
2. Incident policy (enforced by open_incident, which can refuse):
   - open_incident exactly once per target whose check has ok=false AND hard=true (unreachable or HTTP >= 500).
   - NEVER open an incident for a target that answered HTTP with a wrong status (e.g. 404): that is 'degraded' noise — report it, do not escalate it.
   - If list_incidents already shows an open incident for a still-down target, do not open another.
3. Finish with the structured incident report: severity (worst across targets; 'none' if all healthy), affected (unhealthy target names, including degraded), a factual summary, one recommended_action, and your confidence.`;

export const TICK1 = 'Scheduled health tick 1: run all monitored checks and file incidents per policy. Finish with the structured report.';
export const TICK2 =
  'Scheduled health tick 2: re-check all monitored targets, call list_incidents first and never duplicate an open incident. Finish with the structured report.';

export interface MonitorConfig {
  store?: Parameters<typeof createAgent>[0]['store'];
  onEvent?: (e: AgentEvent) => void;
}

export function makeAgent(targets: MonitoredTarget[], token: string | undefined, cfg: MonitorConfig = {}) {
  return createAgent({
    model: LIVE_MODEL, // 'openrouter/openai/gpt-4o-mini' — resolved via OPENROUTER_API_KEY
    name: 'hostinger-monitor',
    instructions: INSTRUCTIONS,
    tools: buildTools(targets, token),
    output: IncidentReport,
    maxSteps: 16,
    toolConcurrency: 4,
    store: cfg.store,
    onEvent: cfg.onEvent,
  });
}

/** The tick schedule: a `run` schedule whose body drives a durable session turn. */
export function makeTickSchedule(prompt: string, capture: (r: unknown) => void) {
  return defineSchedule({
    name: 'health-tick',
    cron: '* * * * *', // every minute; the harness fires it directly via fireSchedule
    run: async (ctx) => {
      const result = await ctx.agent.session({ id: SESSION_ID }).send(prompt);
      capture(result);
    },
  });
}

const t0 = Date.now();
export function logEvent(e: AgentEvent): void {
  const ts = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  const ev = e as Record<string, any>;
  switch (e.type) {
    case 'tool.start':
      console.log(`${ts}s  -> ${ev.toolName}(${JSON.stringify(ev.args ?? '').slice(0, 120)})`);
      break;
    case 'tool.done':
    case 'tool.error':
      console.log(`${ts}s  <- ${ev.toolName} ${ev.error ? 'ERROR ' + JSON.stringify(ev.error).slice(0, 160) : `${JSON.stringify(ev.result ?? '').length} chars`}`);
      break;
    case 'step.done':
    case 'run.done':
      console.log(`${ts}s  ${e.type} ${JSON.stringify({ ...ev, type: undefined, text: undefined, messages: undefined, object: undefined }).slice(0, 200)}`);
      break;
  }
}
