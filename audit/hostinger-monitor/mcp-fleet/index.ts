/**
 * Hostinger fleet monitor over MCP - a READ-ONLY ops agent.
 *
 *   npx tsx hostinger-monitor/mcp-fleet/index.ts            one report (6h window)
 *   npx tsx hostinger-monitor/mcp-fleet/index.ts --cron 2   schedule mode: every minute, stop after 2 ticks
 *   flags: --hours <n>  --command <npx|npx.cmd>  --no-agent  --raw  --offer-search  --debug
 *
 * The Hostinger API token is read from ~/.claude.json at runtime and only ever
 * passed to the MCP child process env. It is never printed or written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, defineSchedule, defineTool, estimateTokens, startSchedules, type AgentEvent, type AgentHook, type Span, type TraceExporter } from '@lousho/build-ai-agent';
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { z } from 'zod';
import { OpenAIProvider } from '@lousho/build-ai-agent';
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
import { collectFleet, type CollectedVm } from './collect.js';
import { EXECUTE_TOOL, READ_ONLY_OPERATIONS, guardHook, guardMcpTools, guardPermissions } from './guard.js';
import { FleetReportSchema, THRESHOLDS, type FleetReport } from './schema.js';
import { readHostingerToken, scrub } from './token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const HOURS = Number(opt('hours', '6'));
const CRON_TICKS = argv.includes('--cron') ? Number(opt('cron', '2')) : 0;
const COMMAND = opt('command', 'npx');
const USE_AGENT = !argv.includes('--no-agent');
const OFFER_SEARCH = argv.includes('--offer-search');
const RAW = argv.includes('--raw'); // model sees MCP results exactly as the SDK produces them
const DEBUG = argv.includes('--debug');
const RUN_ATTEMPTS = Number(opt('attempts', '5'));
const CONTEXT_WINDOW = Number(opt('ctx', '8192')); // LM Studio loaded_context_length

const token = readHostingerToken();
const log = (...parts: unknown[]) => console.log(scrub(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '), token));

// --- Everything the SDK emits is kept in memory so it can be scanned for the token.
const leakSink: string[] = [];
const exporter: TraceExporter = {
  onSpanStart() {},
  onSpanEnd(span: Span) {
    leakSink.push(JSON.stringify(span));
  },
};
const sdkLogger = {
  debug: (m: string, meta?: unknown) => leakSink.push(m + JSON.stringify(meta ?? '')),
  info: (m: string, meta?: unknown) => leakSink.push(m + JSON.stringify(meta ?? '')),
  warn: (m: string, meta?: unknown) => (leakSink.push(m + JSON.stringify(meta ?? '')), log('[sdk warn]', m)),
  error: (m: string, meta?: unknown) => (leakSink.push(m + JSON.stringify(meta ?? '')), log('[sdk error]', m)),
};

// --- 1. Connect the Hostinger MCP server (stdio child process).
const t0 = Date.now();
const mcp = await connectMcp(
  {
    hostinger: {
      command: COMMAND,
      args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'],
      env: { HOSTINGER_API_TOKEN: token },
      // Everything but `search` asks by default; the guard decides instead (allowlist).
      approval: ({ name }) => name !== 'search',
    },
  },
  { logger: sdkLogger as any, onError: 'throw' }
);
log(`[mcp] connected via '${COMMAND}' in ${Date.now() - t0}ms status=${JSON.stringify(mcp.status())} tools=${Object.keys(mcp.tools).join(',')}`);

// --- 2. Read-only tool set (filter + wrapper) and a tiny local tool.
const currentTime = defineTool({
  name: 'current_time',
  description: 'Current UTC time as ISO 8601',
  input: z.object({}),
  annotations: { readOnlyHint: true },
  execute: async () => ({ now: new Date().toISOString() }),
});
const guarded = guardMcpTools(mcp.tools as Record<string, any>);
const offered = OFFER_SEARCH ? guarded : { [EXECUTE_TOOL]: guarded[EXECUTE_TOOL] };
log(`[guard] tools offered to the model: ${Object.keys(offered).join(', ')}, current_time; allowlisted operations: ${READ_ONLY_OPERATIONS.size}`);

// --- 3. Result shaping: MCP text results reach the model as {text, content:[{text}]} (payload twice, see FINDINGS).
const r2 = (n: number) => Math.round(n * 100) / 100;
const stats = (u: Record<string, number> = {}) => {
  const v = Object.values(u).map(Number);
  if (!v.length) return { samples: 0 };
  return { samples: v.length, min: r2(Math.min(...v)), max: r2(Math.max(...v)), avg: r2(v.reduce((a, b) => a + b, 0) / v.length), latest: v.at(-1), sum: r2(v.reduce((a, b) => a + b, 0)) };
};
const planSizes = new Map<number, { memMB: number; diskMB: number }>();
const shapeResults: AgentHook = {
  name: 'shape-mcp-results',
  postToolCall(ctx: any, settled: any) {
    const r = settled.result;
    if (RAW || !(r && typeof r === 'object' && typeof r.text === 'string' && Array.isArray(r.content))) return undefined;
    const op = ctx.args?.operation;
    try {
      if (op === 'vps_virtual-machines_list') for (const vm of JSON.parse(r.text)) planSizes.set(Number(vm.id), { memMB: vm.memory, diskMB: vm.disk });
      if (op === 'vps_virtual-machines_metrics') {
        // Replace each time series by min/max/avg/latest and pre-compute the percentages:
        // a 9B reasoning model loops on 10-digit divisions and overflows an 8k context (see RUN_LOG).
        const plan = planSizes.get(Number(ctx.args?.params?.virtualMachineId));
        const out: Record<string, any> = Object.fromEntries(Object.entries(JSON.parse(r.text)).map(([k, v]: [string, any]) => [k, { unit: v?.unit, ...stats(v?.usage) }]));
        if (plan && out.ram_usage?.latest) out.ram_usage.usedPct = Math.round((out.ram_usage.latest / (plan.memMB * 1048576)) * 1000) / 10;
        if (plan && out.disk_space?.latest) out.disk_space.usedPct = Math.round((out.disk_space.latest / (plan.diskMB * 1048576)) * 1000) / 10;
        return { result: out };
      }
    } catch {
      /* fall through to the plain text */
    }
    return { result: r.text }; // drop the duplicated `content` copy
  },
};
const sizeProbe: AgentHook = {
  name: 'size-probe',
  preGenerate(ctx: any) {
    if (!DEBUG) return;
    const tools = JSON.stringify(ctx.request?.tools ?? []);
    const msgs = JSON.stringify(ctx.messages ?? []);
    log(`[debug] preGenerate messages=${ctx.messages?.length} msgChars=${msgs.length} toolDefChars=${tools.length} ~tokens=${estimateTokens(msgs + tools)}`);
  },
};

const instructions = `You are a READ-ONLY Hostinger VPS fleet monitor. You never change anything.
Use the tool ${EXECUTE_TOOL} with these operations only:
- {"operation":"vps_virtual-machines_list"} -> all VMs (id, hostname, state, plan, cpus, memory MB, disk MB, ipv4[].address)
- {"operation":"vps_virtual-machines_metrics","params":{"virtualMachineId":<id>,"date_from":"<ISO>","date_to":"<ISO>"}} -> cpu_usage (%), ram_usage (bytes), disk_space (bytes), incoming_traffic/outgoing_traffic (bytes), ${RAW ? 'each as {usage:{<unix ts>:<value>}}' : 'each summarised as {samples,min,max,avg,latest}'}
- {"operation":"vps_actions_list","params":{"virtualMachineId":<id>}} -> recent actions
- {"operation":"vps_backups_list","params":{"virtualMachineId":<id>}} -> backups with created_at
Steps: list VMs, then for EACH VM call metrics, actions and backups. Then answer.
${RAW ? 'ramUsedPct = latest ram bytes / (memory MB * 1048576) * 100. diskUsedPct = latest disk bytes / (disk MB * 1048576) * 100.' : 'cpuAvgPct = cpu_usage.avg, cpuMaxPct = cpu_usage.max, ramUsedPct = ram_usage.usedPct, diskUsedPct = disk_space.usedPct (already computed; do not do arithmetic).'}
Anomalies: state not running; cpu avg > ${THRESHOLDS.cpuAvgPct}% or max > ${THRESHOLDS.cpuMaxPct}%; ram > ${THRESHOLDS.ramUsedPct}%; disk > ${THRESHOLDS.diskUsedPct}%; newest backup older than 8 days or none; any action not in state success.
fleetStatus: critical if any VM is not running or disk > 95%, warning if any anomaly, else ok.`;

const events: AgentEvent[] = [];
const agent = createAgent({
  name: 'hostinger-monitor',
  // maxRetries: 0 - a provider INSTANCE otherwise keeps the ai SDK's hidden 2 retries, stacked under `retry` (FINDINGS).
  provider: new OpenAIProvider({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL, defaultModel: LOCAL_MODEL, maxRetries: 0 }),
  // The shared LM Studio KV cache overflows under load from other clients ("Context size has been exceeded.");
  // the SDK classifies it 'unknown', so retry it explicitly with a long backoff.
  retry: {
    maxRetries: Number(opt('retries', '6')),
    backoff: { initialMs: 10_000, maxMs: 45_000 },
    retryOn: (e: any) => /Context size has been exceeded|ECONNRESET|fetch failed/i.test(String(e?.message ?? e)),
    onRetry: ({ attempt, delayMs }) => log(`[retry] model call attempt ${attempt} failed (shared server busy), retrying in ${Math.round(delayMs / 1000)}s`),
  },
  instructions,
  tools: [offered, currentTime],
  permissions: guardPermissions,
  hooks: [guardHook, shapeResults, sizeProbe],
  onPermissionDecision: (e) => {
    if (e.decision === 'deny') log(`[guard] DENIED ${e.toolName} ${JSON.stringify(e.args ?? {})}`);
  },
  output: FleetReportSchema,
  maxSteps: 14,
  // No model call has a default timeout: a request hung across an LM Studio model reload blocked a cron tick for 13+ min.
  limits: { maxDurationMs: Number(opt('max-ms', '480000')) },
  exporter,
  captureContent: true,
  onEvent: (e) => {
    events.push(e);
    leakSink.push(JSON.stringify(e));
    if (DEBUG && !String(e.type).includes('delta')) log(`[debug] event ${e.type} ${JSON.stringify(e).slice(0, 200)}`);
  },
  // The registry does not know this local model: without contextWindow the SDK assumes 128k (see FINDINGS).
  compaction: { contextWindow: CONTEXT_WINDOW, thresholdPercent: 0.6, protectedTokens: 1500 },
});

// --- 4. One monitoring pass.
async function runOnce(tag: string): Promise<void> {
  const started = new Date();
  const outDir = join(HERE, 'out');
  mkdirSync(outDir, { recursive: true });

  const truth: CollectedVm[] = await collectFleet(guarded, HOURS, started);
  log(`[${tag}] deterministic: ${truth.length} VM(s); anomalies=${JSON.stringify(truth.map((v) => v.anomalies))}`);

  let agentPart: { object?: FleetReport; finishReason: string; steps?: number; usage?: unknown; outputError?: unknown; error?: string; ms: number; toolCalls?: string[] } | undefined;
  if (USE_AGENT) {
    const a0 = Date.now();
    events.length = 0;
    const to = started.toISOString();
    const from = new Date(started.getTime() - HOURS * 3600e3).toISOString();
    try {
      // withRetry cannot retry a STREAMED step that fails after its first chunk (LM Studio streams reasoning, then
      // fails mid-generation when the shared KV cache fills), so the whole run is retried here.
      let r!: Awaited<ReturnType<typeof agent.send>>;
      for (let attempt = 1; ; attempt++) {
        try {
          r = await agent.send(`Produce the fleet health report. Metrics window: date_from=${from} date_to=${to}.`);
          break;
        } catch (e: any) {
          if (attempt >= RUN_ATTEMPTS || !/Context size has been exceeded/.test(String(e?.message))) throw e;
          log(`[${tag}] run attempt ${attempt} hit the shared server's context limit; retrying the run in 30s`);
          events.length = 0;
          await new Promise((res) => setTimeout(res, 30_000));
        }
      }
      const toolCalls = events.filter((e) => e.type === 'tool.start').map((e: any) => `${e.toolName}(${e.args?.operation ?? ''})`);
      agentPart = { object: r.object, finishReason: r.finishReason, usage: r.usage, outputError: r.outputError, ms: Date.now() - a0, toolCalls };
      log(`[${tag}] agent finishReason=${r.finishReason} in ${Date.now() - a0}ms tools=[${toolCalls.join(', ')}] compactions=${events.filter((e) => e.type === 'compaction.done').length} usage=${JSON.stringify(r.usage)}`);
      if (!r.object) log(`[${tag}] agent outputError=${JSON.stringify(r.outputError)?.slice(0, 400)} text=${r.text?.slice(0, 300)}`);
    } catch (error: any) {
      agentPart = { finishReason: 'threw', error: `${error?.name}: ${error?.message}`, ms: Date.now() - a0 };
      log(`[${tag}] agent threw after ${Date.now() - a0}ms: ${error?.name} [${error?.code}] category=${error?.category ?? '-'}: ${String(error?.message).slice(0, 300)}`);
    }
  }

  // Cross-check: model numbers vs deterministic numbers.
  const discrepancies: string[] = [];
  if (agentPart?.object) {
    for (const t of truth) {
      const m = agentPart.object.vms.find((v) => v.id === t.id);
      if (!m) {
        discrepancies.push(`vm ${t.id}: missing from agent report`);
        continue;
      }
      for (const k of ['cpuAvgPct', 'cpuMaxPct', 'ramUsedPct', 'diskUsedPct'] as const) {
        if (Math.abs(m[k] - t[k]) > Math.max(2, t[k] * 0.15)) discrepancies.push(`vm ${t.id}: ${k} agent=${m[k]} actual=${t[k]}`);
      }
      if (m.state !== t.state) discrepancies.push(`vm ${t.id}: state agent=${m.state} actual=${t.state}`);
      if ((m.lastBackupAt ?? '').slice(0, 10) !== (t.lastBackupAt ?? '').slice(0, 10)) discrepancies.push(`vm ${t.id}: lastBackupAt agent=${m.lastBackupAt} actual=${t.lastBackupAt}`);
      if (m.anomalies.length !== t.anomalies.length) discrepancies.push(`vm ${t.id}: anomalies agent=${JSON.stringify(m.anomalies)} actual=${JSON.stringify(t.anomalies)}`);
    }
  }

  const anomalies = truth.flatMap((v) => v.anomalies.map((a) => `${v.hostname}: ${a}`));
  const fleetStatus = truth.some((v) => v.state !== 'running' || v.diskUsedPct > 95) ? 'critical' : anomalies.length ? 'warning' : 'ok';
  const report = { generatedAt: started.toISOString(), windowHours: HOURS, model: LOCAL_MODEL, fleetStatus, anomalies, vms: truth, agent: agentPart, discrepancies };
  writeFileSync(join(outDir, 'report.json'), scrub(JSON.stringify(report, null, 2), token));
  writeFileSync(join(outDir, 'report.md'), scrub(toMarkdown(report), token));
  log(`[${tag}] wrote out/report.json + out/report.md fleetStatus=${fleetStatus} anomalies=${anomalies.length} discrepancies=${JSON.stringify(discrepancies)}`);
}

function toMarkdown(r: any): string {
  return [
    `# Hostinger fleet health - ${r.generatedAt}`,
    '',
    `**Fleet status:** ${r.fleetStatus.toUpperCase()}  |  window: last ${r.windowHours}h  |  model: ${r.model}`,
    '',
    '| VM | state | plan | IPv4 | CPU avg/max | RAM | disk | net in/out (MB) | last backup | anomalies |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...r.vms.map(
      (v: CollectedVm) =>
        `| ${v.hostname} (${v.id}) | ${v.state} | ${v.plan} | ${v.ipv4} | ${v.cpuAvgPct}% / ${v.cpuMaxPct}% | ${v.ramUsedPct}% | ${v.diskUsedPct}% | ${v.netInMB} / ${v.netOutMB} | ${v.lastBackupAt ?? 'none'} (${v.backupAgeHours ?? '-'}h) | ${v.anomalies.join(', ') || 'none'} |`
    ),
    '',
    '## Recent actions',
    ...r.vms.flatMap((v: CollectedVm) => [`- **${v.hostname}**`, ...v.recentActions.map((a) => `  - ${a}`)]),
    '',
    '## Agent assessment',
    r.agent?.object
      ? `> ${r.agent.object.summary}\n\nAgent fleetStatus: **${r.agent.object.fleetStatus}**; agent anomalies: ${JSON.stringify(r.agent.object.vms.map((v: any) => v.anomalies))}`
      : `_Agent produced no structured report (${r.agent?.finishReason ?? 'disabled'}${r.agent?.error ? `: ${r.agent.error.slice(0, 160)}` : ''})._`,
    '',
    r.agent?.object ? (r.discrepancies.length ? `### Agent vs. API discrepancies\n${r.discrepancies.map((d: string) => `- ${d}`).join('\n')}` : '_Agent numbers match the API within tolerance._') : '',
  ].join('\n') + '\n';
}

// --- 5. Run once, or as a schedule for N ticks.
async function shutdown() {
  await mcp.close();
  const leaked = leakSink.some((s) => s.includes(token));
  log(`[leak-check] scanned ${leakSink.length} trace spans/events/log lines: token present=${leaked}`);
  log(`[mcp] closed status=${JSON.stringify(mcp.status())}`);
}

if (!CRON_TICKS) {
  await runOnce('once');
  await shutdown();
} else {
  let ticks = 0;
  let inFlight: Promise<void> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const keepAlive = setInterval(() => {}, 60_000); // startSchedules' timers are unref()'d (see FINDINGS)
  const running = startSchedules(
    agent,
    [
      defineSchedule({
        name: 'fleet-health',
        cron: opt('cron-expr', '* * * * *'), // every minute here; production: '*/15 * * * *'
        run: async ({ firedAt }) => {
          ticks++;
          if (ticks > CRON_TICKS) return;
          log(`[cron] tick ${ticks} firedAt=${firedAt.toISOString()}`);
          inFlight = runOnce(`tick${ticks}`);
          await inFlight;
          if (ticks >= CRON_TICKS) finish();
        },
      }),
    ],
    { onError: (e, s) => log(`[cron] schedule '${s.name}' error: ${(e as Error)?.message}`) }
  );
  log(`[cron] started; waiting for ${CRON_TICKS} tick(s)`);
  await done;
  running.stop(); // returns void: does not wait for an in-flight run
  await inFlight;
  clearInterval(keepAlive);
  await shutdown();
}
