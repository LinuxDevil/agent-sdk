/**
 * Agent + tool wiring for the incident-responder harness.
 *
 * Layout (all `createAgent()` agents, model = LIVE_MODEL):
 *
 *   commander (incident commander; reached through the webhook channel)
 *     ├─ subagents (the `task` tool, fanned out in parallel):
 *     │    logs-investigator, metrics-investigator, deploys-investigator
 *     │      -> each owns ONE tool, all named `query_telemetry`, returning
 *     │         different fixture data (proves per-sub-agent tool isolation)
 *     │    severity-triage
 *     │      -> `output` schema {severity, confidence, rationale}: the
 *     │         typed decision (LOU-V4.2 sub-agent output)
 *     ├─ tools: restart_service (needsApproval -> pauses the run)
 *     └─ handoffs: report-writer (writes incidents/<id>.md)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, defineTool, handoff, fileStore } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../_shared/env.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const STORE_DIR = join(HERE, '.lousho');
export const INCIDENTS_DIR = join(HERE, 'incidents');

/** Confidence floor: below it the commander must escalate, never remediate. */
export const CONFIDENCE_FLOOR = 0.7;

/* ------------------------------------------------------------------ */
/* Observable state the harness asserts on                             */
/* ------------------------------------------------------------------ */

export interface Span {
  investigator: string;
  startedAt: number;
  endedAt: number;
}
/** Wall-clock span of each investigator's tool run: overlap proves the task fan-out ran in parallel. */
export const investigatorSpans: Span[] = [];
/** restart_service calls that actually executed (approval granted). */
export const restartCalls: { service: string; reason: string }[] = [];
/** restart_service calls that were requested (the model invoked the tool). */
export const restartRequests: { service: string; reason: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Mock telemetry (what a real observer backend would return)          */
/* ------------------------------------------------------------------ */

const FIXTURES: Record<string, { logs: unknown; metrics: unknown; deploys: unknown }> = {
  checkout: {
    logs: {
      service: 'checkout',
      window: '14:00Z-14:15Z',
      errors5xx: 1842,
      sample: [
        '14:02:11Z ERROR PaymentGateway.charge: NullPointerException at providerClient.ts:88',
        '14:02:14Z ERROR upstream timeout after 5000ms (payment-provider)',
        '14:03:02Z ERROR PaymentGateway.charge: NullPointerException at providerClient.ts:88',
      ],
      note: 'errors started abruptly at 14:02Z; ~42% of requests failing',
    },
    metrics: {
      service: 'checkout',
      error_rate_pct: 42.3,
      p95_latency_ms: 8100,
      p95_baseline_ms: 950,
      started_at: '14:02Z',
      note: 'error rate jumped from 0.1% to 42% at 14:02Z; latency 8.5x baseline',
    },
    deploys: {
      service: 'checkout',
      recent: [
        { version: '2.14.0', at: '13:58Z', author: 'payments-team', change: 'migrate PaymentGateway to new providerClient' },
        { version: '2.13.2', at: '3 days ago', author: 'payments-team', change: 'retry tuning' },
      ],
      note: 'checkout@2.14.0 deployed 4 minutes before the error spike began',
    },
  },
  'staging-api': {
    logs: {
      service: 'staging-api',
      window: '03:00Z-03:15Z',
      errors5xx: 0,
      sample: [],
      note: 'no 5xx errors found in the alert window',
    },
    metrics: {
      service: 'staging-api',
      error_rate_pct: 0.0,
      p95_latency_ms: 410,
      p95_baseline_ms: 380,
      note: 'single 30-second blip to 1.8% error rate at 03:12Z, self-recovered; all metrics normal',
    },
    deploys: {
      service: 'staging-api',
      recent: [],
      note: 'no deploys in the last 72 hours',
    },
  },
};

function fixture(service: string, kind: 'logs' | 'metrics' | 'deploys'): unknown {
  const f = FIXTURES[service] ?? {
    logs: { service, note: 'no log data for this service' },
    metrics: { service, note: 'no metrics for this service' },
    deploys: { service, note: 'no deploy data for this service' },
  };
  return f[kind];
}

/* ------------------------------------------------------------------ */
/* Investigator sub-agents — all three tools share the name            */
/* `query_telemetry`; different implementations prove each sub-agent    */
/* gets its own isolated tool registry.                                */
/* ------------------------------------------------------------------ */

function investigator(name: string, kind: 'logs' | 'metrics' | 'deploys', blurb: string) {
  const telemetry = defineTool({
    name: 'query_telemetry',
    description: `Fetch ${kind} data for a service. ${blurb}`,
    input: z.object({ service: z.string().describe('service name, e.g. checkout') }),
    async execute({ service }) {
      const startedAt = Date.now();
      await sleep(1200); // simulate backend latency; overlap across the 3 spans proves parallel fan-out
      const endedAt = Date.now();
      investigatorSpans.push({ investigator: kind, startedAt, endedAt });
      return fixture(service, kind);
    },
  });
  return createAgent({
    name,
    description: `Investigates ${kind} for a service during an incident`,
    model: LIVE_MODEL,
    instructions:
      `You are the ${kind} investigator for incident response. ` +
      `Call query_telemetry exactly once with the service named in the task, then report the key findings ` +
      `(and whether anything looks anomalous) in 2-3 sentences. Do not speculate beyond the data.`,
    tools: [telemetry],
    maxSteps: 4,
  });
}

/* ------------------------------------------------------------------ */
/* severity-triage: typed decision via the `output` schema             */
/* ------------------------------------------------------------------ */

export const SeverityDecision = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1).describe('0-1; corroboration across investigators'),
  rationale: z.string().describe('one sentence'),
});
export type SeverityDecision = z.infer<typeof SeverityDecision>;

const triage = createAgent({
  name: 'severity-triage',
  description: 'Classifies incident severity from investigator reports',
  model: LIVE_MODEL,
  output: SeverityDecision,
  instructions:
    'You are the severity triage function of an incident-response team. ' +
    'You receive the raw reports of the logs, metrics and deploys investigators and return a severity decision. ' +
    'severity: critical = full outage or data loss; high = major user-facing errors (5xx storm, payment failures); ' +
    'medium = partial degradation; low = no real user impact. ' +
    'confidence (0-1) reflects corroboration: two or more investigators reporting concrete anomalies that agree ' +
    '(e.g. an error spike plus a correlating deploy) is confidence 0.8-0.95. Conflicting or absent evidence, ' +
    'or only one weak signal, is confidence <= 0.5. A clean bill of health from all investigators is ' +
    'confidence <= 0.3 for any severity above low.',
});

/* ------------------------------------------------------------------ */
/* Remediation tool (approval-gated)                                   */
/* ------------------------------------------------------------------ */

const restartService = defineTool({
  name: 'restart_service',
  description: 'Restart a service to remediate an incident. Mutates infrastructure - always requires human approval.',
  input: z.object({
    service: z.string(),
    reason: z.string().describe('why this restart is justified'),
  }),
  needsApproval: true,
  async execute({ service, reason }) {
    restartCalls.push({ service, reason });
    return { restarted: service, at: new Date().toISOString(), reason };
  },
});

/* ------------------------------------------------------------------ */
/* report-writer: handoff target that produces incidents/<id>.md       */
/* ------------------------------------------------------------------ */

const writeIncidentReport = defineTool({
  name: 'write_incident_report',
  description: 'Write the final incident report markdown file to the incident store.',
  input: z.object({
    incidentId: z.string().describe('incident id, e.g. INC-7001'),
    markdown: z.string().describe('full markdown report'),
  }),
  async execute({ incidentId, markdown }) {
    mkdirSync(INCIDENTS_DIR, { recursive: true });
    const file = join(INCIDENTS_DIR, `${incidentId.replace(/[^A-Za-z0-9_-]/g, '_')}.md`);
    writeFileSync(file, markdown, 'utf8');
    return { path: file, bytes: markdown.length };
  },
});

const reportWriter = createAgent({
  name: 'report_writer',
  description: 'Writes the final incident report file and confirms it',
  model: LIVE_MODEL,
  instructions:
    'You are the incident report writer. Read the whole incident transcript handed to you, then call ' +
    'write_incident_report exactly once with a complete markdown report: title with incident id, severity ' +
    'decision and confidence, timeline, root-cause hypothesis, remediation performed, and follow-ups. ' +
    'Then reply in one short sentence confirming the report was written and where.',
  tools: [writeIncidentReport],
  maxSteps: 4,
});

/* ------------------------------------------------------------------ */
/* The commander (webhook entry point)                                 */
/* ------------------------------------------------------------------ */

const COMMANDER_INSTRUCTIONS = `You are the incident commander of an on-call response team. An alert arrives as your input. Follow this protocol EXACTLY:

1. FAN-OUT: in your FIRST response, issue three \`task\` tool calls in one turn - one to 'logs-investigator', one to 'metrics-investigator', one to 'deploys-investigator' - each prompt naming the service and summarizing the alert. Do NOT use background mode and do NOT call agent_status or agent_await; plain parallel \`task\` calls return their results directly. Do not investigate yourself.
2. TRIAGE: once all three reports are back, call \`task\` with agent 'severity-triage' and paste the full text of all three reports into its prompt. It replies with a JSON object {severity, confidence, rationale}.
3. DECIDE (mandatory - never end your turn with just a summary):
   - If severity is 'high' or 'critical' AND confidence >= ${CONFIDENCE_FLOOR}: call \`restart_service\` for the affected service (this pauses for human approval - that is expected and correct).
   - Otherwise DO NOT call restart_service. State clearly that the incident is ESCALATED to a human on-call engineer (include the severity, confidence and rationale) and finish.
4. REPORT: after a successful restart_service result, call the transfer_to_report_writer tool to hand off for the incident report.
Never invent data; only use what the sub-agents returned.`;

export function buildCommander() {
  const store = fileStore(STORE_DIR);
  const commander = createAgent({
    name: 'commander',
    model: LIVE_MODEL,
    instructions: COMMANDER_INSTRUCTIONS,
    tools: [restartService],
    hooks: [
      {
        name: 'audit',
        // Counts every tool call the model *requested* (before approval), so the
        // harness can tell "asked to restart" apart from "actually restarted".
        preToolCall(ctx) {
          if (ctx.toolName === 'restart_service') {
            restartRequests.push({ service: String(ctx.args.service), reason: String(ctx.args.reason ?? '') });
          }
        },
      },
    ],
    subagents: {
      'logs-investigator': investigator('logs-investigator', 'logs', 'Error/warning counts and representative lines.'),
      'metrics-investigator': investigator('metrics-investigator', 'metrics', 'Error rate, latency percentiles vs baseline.'),
      'deploys-investigator': investigator('deploys-investigator', 'deploys', 'Recent deploys and config changes.'),
      'severity-triage': triage,
    },
    handoffs: [handoff(reportWriter)],
    store,
    maxSteps: 15,
  });
  return { commander, store };
}
