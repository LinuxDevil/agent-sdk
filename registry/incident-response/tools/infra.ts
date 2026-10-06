/**
 * The kit's simulated infrastructure: a canned production/staging estate plus
 * the tools the responder calls against it. Everything runs offline - `infra`
 * is an in-memory fixture the tools read and mutate, so a restart or a scale
 * is visible to later calls (a test reloads this module and calls
 * `resetInfra()`).
 *
 * The remediation tools take an `environment` argument AND cross-check it
 * against the service's real environment: a permission rule that allows
 * "staging" trusts the argument the model wrote, so the tool refuses a call
 * that labels a production service as staging.
 */
import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

export type Environment = 'staging' | 'production';
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'restarting';

export interface ServiceState {
  name: string;
  environment: Environment;
  status: ServiceStatus;
  replicas: number;
  desiredReplicas: number;
  version: string;
  restarts: number;
}

export interface UpdateEntry {
  at: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

export interface InfraState {
  services: Record<string, ServiceState>;
  /** table -> rows still present; drop_table / delete_data eat into this. */
  databases: Record<string, { rows: number }>;
  /** Status-page updates the agent posted. */
  updates: UpdateEntry[];
  logs: Record<string, string[]>;
  runbooks: Record<string, { title: string; steps: string[] }>;
}

const seed = (): InfraState => ({
  services: {
    'payments-api': {
      name: 'payments-api',
      environment: 'production',
      status: 'degraded',
      replicas: 3,
      desiredReplicas: 3,
      version: 'v2.14.0',
      restarts: 1,
    },
    'checkout-web': {
      name: 'checkout-web',
      environment: 'staging',
      status: 'healthy',
      replicas: 2,
      desiredReplicas: 2,
      version: 'v1.9.3',
      restarts: 0,
    },
    'orders-db': {
      name: 'orders-db',
      environment: 'production',
      status: 'healthy',
      replicas: 1,
      desiredReplicas: 1,
      version: 'postgres-16.2',
      restarts: 0,
    },
  },
  databases: {
    payments: { rows: 184_203 },
    sessions: { rows: 51_977 },
  },
  updates: [],
  logs: {
    'payments-api': [
      '2024-05-11T14:02:11Z ERROR pool: connection timeout after 5000ms (pool exhausted, 32/32 in use)',
      '2024-05-11T14:02:14Z ERROR handler POST /charges failed: upstream timeout (payments-db)',
      '2024-05-11T14:02:31Z WARN  heap: 87% of limit, GC pause 1.2s',
      '2024-05-11T14:03:02Z ERROR pool: connection timeout after 5000ms (pool exhausted, 32/32 in use)',
      '2024-05-11T14:03:19Z ERROR handler POST /charges failed: upstream timeout (payments-db)',
    ],
    'checkout-web': [
      '2024-05-11T13:58:40Z INFO  GET /cart 200 in 41ms',
      '2024-05-11T14:01:55Z INFO  GET /checkout 200 in 63ms',
    ],
    'orders-db': [
      '2024-05-11T14:00:00Z INFO  checkpoint completed, wrote 812 buffers',
      '2024-05-11T14:05:00Z INFO  automatic vacuum of "orders": index scans 0',
    ],
  },
  runbooks: {
    'high-error-rate': {
      title: 'Elevated error rate on a service',
      steps: [
        'Correlate check_logs and query_metrics(error_rate, latency_p99) to find the failing dependency.',
        'If logs show an exhausted resource (pool, heap), a rolling restart clears the leak - this is tier 2 in production.',
        'If errors track a traffic spike, scale replicas instead - check the spike is real, not a retry storm.',
        'Verify error_rate returns to baseline with query_metrics before calling the incident mitigated.',
      ],
    },
    restart: {
      title: 'Rolling restart of a service',
      steps: [
        'restart_service performs a rolling restart; replicas stay up one short during the roll.',
        'Staging restarts are pre-approved. Production restarts need approval - state the blast radius in the request.',
        'After the restart, check_status must report healthy and query_metrics(error_rate) must fall before you post "mitigated".',
      ],
    },
    scale: {
      title: 'Scaling a service',
      steps: [
        'scale_replicas changes desiredReplicas; the platform converges within ~60s.',
        'Never scale to 0 during an incident - that is an outage, not a remediation. The approver refuses it.',
        'Verify with check_status that replicas converged.',
      ],
    },
  },
});

/** The live fixture the tools operate on. */
export const infra: InfraState = seed();

/** Back to the seeded state (tests). Mutates in place so importers keep their reference. */
export function resetInfra(): InfraState {
  const fresh = seed();
  infra.services = fresh.services;
  infra.databases = fresh.databases;
  infra.updates = fresh.updates;
  infra.logs = fresh.logs;
  infra.runbooks = fresh.runbooks;
  return infra;
}

const serviceArg = z.string().describe('The service name, e.g. "payments-api"');
const environmentArg = z.enum(['staging', 'production']).describe('The environment the caller believes the service runs in - verified against the estate.');

/** The service entry, or a model-facing error string. */
function service(name: string): ServiceState | { error: string } {
  const entry = infra.services[name];
  return entry ?? { error: `unknown service '${name}'. Known services: ${Object.keys(infra.services).join(', ')}` };
}

/**
 * Guards the environment claim: a permission rule that allows "staging" sees
 * only the argument, so the tool itself refuses when the claim disagrees with
 * the estate.
 */
function envGuard(entry: ServiceState, claimed: Environment): { error: string } | undefined {
  if (entry.environment !== claimed) {
    return {
      error: `environment mismatch: '${entry.name}' runs in ${entry.environment}, not ${claimed}. Re-issue the call with the real environment so it passes through the right approval tier.`,
    };
  }
  return undefined;
}

export const check_logs = defineTool({
  name: 'check_logs',
  description: 'Read the most recent log lines of a service (read-only)',
  input: z.object({
    service: serviceArg,
    severity: z.enum(['info', 'warn', 'error']).optional().describe('Only lines at or above this severity'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum lines to return (default 20)'),
  }),
  annotations: { readOnlyHint: true },
  execute({ service: name, severity, limit = 20 }) {
    const entry = service(name);
    if ('error' in entry) return entry;
    const floor = severity === 'error' ? 'ERROR' : severity === 'warn' ? 'WARN' : '';
    const lines = (infra.logs[name] ?? []).filter((line) => floor === '' || line.includes(floor)).slice(-limit);
    return { service: name, environment: entry.environment, lines };
  },
});

/** A plausible metric series: baseline wiggle, with a spike while the service is degraded. */
function series(entry: ServiceState, metric: string): { t: string; v: number }[] {
  const baseline: Record<string, number> = { error_rate: 0.4, latency_p99: 120, cpu: 34, memory: 58, restarts: entry.restarts };
  const spiked: Record<string, number> = { error_rate: 14.2, latency_p99: 5100, cpu: 61, memory: 87, restarts: entry.restarts };
  const hot = entry.status === 'degraded' || entry.status === 'down';
  const now = Date.UTC(2024, 4, 11, 14, 0, 0);
  return [0, 1, 2, 3, 4].map((i) => {
    const base = baseline[metric] ?? 0;
    const value = hot && i >= 3 ? (spiked[metric] ?? base) : base + i * 0.05;
    return { t: new Date(now - (4 - i) * 60_000).toISOString(), v: Math.round(value * 100) / 100 };
  });
}

export const query_metrics = defineTool({
  name: 'query_metrics',
  description: 'Query a service metric over the last window (read-only): error_rate, latency_p99, cpu, memory or restarts',
  input: z.object({
    service: serviceArg,
    metric: z.enum(['error_rate', 'latency_p99', 'cpu', 'memory', 'restarts']),
    windowMinutes: z.number().int().min(1).max(120).optional().describe('Lookback window (default 5m)'),
  }),
  annotations: { readOnlyHint: true },
  execute({ service: name, metric, windowMinutes = 5 }) {
    const entry = service(name);
    if ('error' in entry) return entry;
    const points = series(entry, metric);
    const latest = points.at(-1)!.v;
    return {
      service: name,
      metric,
      windowMinutes,
      points,
      summary: { current: latest, baseline: points[0].v, elevated: latest > points[0].v * 1.5 },
    };
  },
});

export const get_runbook = defineTool({
  name: 'get_runbook',
  description: 'Fetch the runbook procedure for a topic (read-only): "high-error-rate", "restart", "scale"',
  input: z.object({ topic: z.string().describe('Runbook topic, e.g. "high-error-rate"') }),
  annotations: { readOnlyHint: true },
  execute({ topic }) {
    const runbook = infra.runbooks[topic];
    if (!runbook) return { error: `no runbook for '${topic}'. Available: ${Object.keys(infra.runbooks).join(', ')}` };
    return { topic, ...runbook };
  },
});

export const check_status = defineTool({
  name: 'check_status',
  description: 'Current status of a service: health, replica count vs desired, version, restart count (read-only)',
  input: z.object({ service: serviceArg }),
  annotations: { readOnlyHint: true },
  execute({ service: name }) {
    const entry = service(name);
    if ('error' in entry) return entry;
    return { ...entry, converged: entry.replicas === entry.desiredReplicas };
  },
});

export const restart_service = defineTool({
  name: 'restart_service',
  description: 'Perform a rolling restart of a service. Staging restarts are pre-approved; production restarts need human approval.',
  input: z.object({
    service: serviceArg,
    environment: environmentArg,
    reason: z.string().optional().describe('Why the restart is needed - recorded on the incident timeline'),
  }),
  execute({ service: name, environment, reason }) {
    const entry = service(name);
    if ('error' in entry) return entry;
    const mismatch = envGuard(entry, environment);
    if (mismatch) return mismatch;
    const before = entry.status;
    entry.status = 'healthy';
    entry.restarts += 1;
    return {
      service: name,
      environment: entry.environment,
      before,
      after: entry.status,
      restarts: entry.restarts,
      ...(reason !== undefined && { reason }),
    };
  },
});

export const scale_replicas = defineTool({
  name: 'scale_replicas',
  description: 'Set the desired replica count of a service (1-20). Scaling to 0 during an incident is refused by policy.',
  input: z.object({
    service: serviceArg,
    environment: environmentArg,
    replicas: z.number().int().min(0).max(20).describe('Desired replica count'),
  }),
  execute({ service: name, environment, replicas }) {
    const entry = service(name);
    if ('error' in entry) return entry;
    const mismatch = envGuard(entry, environment);
    if (mismatch) return mismatch;
    const before = entry.desiredReplicas;
    entry.desiredReplicas = replicas;
    entry.replicas = replicas;
    return { service: name, environment: entry.environment, before, replicas: entry.replicas };
  },
});

export const post_update = defineTool({
  name: 'post_update',
  description: 'Post a status-page update for the incident (visible to stakeholders)',
  input: z.object({
    message: z.string().describe('The update text, e.g. "payments-api restarted; error rate recovering"'),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
  }),
  execute({ message, severity = 'info' }) {
    const update: UpdateEntry = { at: new Date().toISOString(), severity, message };
    infra.updates.push(update);
    return { posted: true, update };
  },
});

/**
 * The destructive capabilities the estate exposes - present so the permission
 * rules have something real to fence. Both are denied by agent.json; if that
 * gate ever regressed these would actually destroy fixture state.
 */
export const drop_table = defineTool({
  name: 'drop_table',
  description: 'Drop a database table and all its rows. DESTRUCTIVE - never within the incident mandate.',
  input: z.object({ table: z.string().describe('Table name, e.g. "payments"') }),
  execute({ table }) {
    const target = infra.databases[table];
    if (!target) return { error: `unknown table '${table}'. Known tables: ${Object.keys(infra.databases).join(', ')}` };
    const rows = target.rows;
    delete infra.databases[table];
    return { dropped: table, rowsLost: rows };
  },
});

export const delete_data = defineTool({
  name: 'delete_data',
  description: 'Delete rows from a database table. DESTRUCTIVE - never within the incident mandate.',
  input: z.object({
    table: z.string(),
    where: z.string().optional().describe('Row predicate; without it every row goes'),
  }),
  execute({ table, where }) {
    const target = infra.databases[table];
    if (!target) return { error: `unknown table '${table}'. Known tables: ${Object.keys(infra.databases).join(', ')}` };
    const deleted = where === undefined ? target.rows : Math.floor(target.rows / 10);
    target.rows -= deleted;
    return { table, rowsDeleted: deleted, rowsRemaining: target.rows };
  },
});

export default [
  check_logs,
  query_metrics,
  get_runbook,
  check_status,
  restart_service,
  scale_replicas,
  post_update,
  drop_table,
  delete_data,
];
