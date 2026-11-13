/**
 * The per-workspace trigger stack (R08a host + R08c cron scheduler +
 * R08b channel mounts), built and started together so the workspace
 * context and the legacy app context behave identically: webhook/cron
 * dispatches queue through the workspace's own RunManager, trigger-phase
 * log lines land on the same run-log stream RunManager's own entries
 * use, and channel triggers mount the SDK's channel handlers per agent.
 */
import { randomUUID } from 'node:crypto';

import type { SimpleAgent, TraceExporter } from '@linuxdevil/lousho';
import { fanOutExporters, fileTraceExporter } from '@linuxdevil/lousho/traces';

import type { LogEntry } from '../../shared/wireTypes';
import { buildRunnableAgent, type StudioRunDeps } from '../buildAgentV2';
import { observeReporting, type ObserveReporting } from '../observeReporting';
import { agentTraceDir } from '../traceStore';
import type { AgentRepo } from '../storage/agentRepo';
import type { StudioEventBus } from '../events/eventBus';
import type { RunManager } from '../runRegistry';
import { ChannelTriggers, type SecretResolver } from './channelTriggers';
import { CronTriggers } from './cronTriggers';
import { TriggerHost } from './triggerHost';

export interface TriggerRuntimeDeps {
  /** The workspace root (`ws.ref.root`); `.lousho/agents` hangs off it. */
  baseDir: string;
  repo: AgentRepo;
  runManager: RunManager;
  events: StudioEventBus;
  /**
   * The stores a channel turn's agent builds through (R08b) - the same
   * `StudioRunDeps` the workspace's `InProcessAgentHost` gets.
   */
  studio: StudioRunDeps;
  /** Report channel-turn spans to the observe daemon, like RunManager's runs. */
  observe?: boolean;
}

export interface TriggerRuntime {
  triggers: TriggerHost;
  cron: CronTriggers;
  channels: ChannelTriggers;
}

/** Channel turns trace to the agent's trace folder (+ observe), never the test pane's live feed. */
function channelExporter(baseDir: string, agentId: string, reporting: ObserveReporting | undefined): TraceExporter {
  const spans = [fileTraceExporter({ dir: agentTraceDir(baseDir, agentId) })];
  if (reporting !== undefined) spans.push(reporting.exporter());
  return fanOutExporters(spans) as TraceExporter;
}

/** `trigger.secrets` values: `{ env }` reads the process env, `{ secret }` the Studio store, strings pass through. */
function secretResolver(studio: StudioRunDeps): SecretResolver {
  return (ref) => {
    if (typeof ref === 'string') return ref;
    if ('env' in ref) return process.env[ref.env];
    return studio.secretsStore?.getSecret(ref.secret);
  };
}

export function createTriggerRuntime(deps: TriggerRuntimeDeps): TriggerRuntime {
  // Observe reporters are per-agent and reused across remounts, like
  // RunManager's own `reporting` map.
  const reporting = new Map<string, ObserveReporting>();
  const reportingFor = (agentId: string): ObserveReporting | undefined => {
    if (deps.observe !== true) return undefined;
    let reporter = reporting.get(agentId);
    if (reporter === undefined) {
      reporter = observeReporting({ agentName: agentId, baseDir: deps.baseDir });
      reporting.set(agentId, reporter);
    }
    return reporter;
  };
  // A channel turn builds the working-copy spec through the same
  // buildRunnableAgent runs use; its wiring only differs in the sinks -
  // spans go to the trace file + observe reporter, agent events to
  // nowhere (channel sessions live inside the SDK, not RunManager).
  const buildAgent = async (agentId: string): Promise<SimpleAgent> => {
    const spec = await deps.repo.readSpec(agentId);
    if (spec === undefined) throw new Error(`No spec for agent '${agentId}'`);
    const built = await buildRunnableAgent(spec, agentId, deps.studio, {
      onEvent: () => {},
      exporter: channelExporter(deps.baseDir, agentId, reportingFor(agentId)),
    });
    return built.agent;
  };

  const triggers = new TriggerHost({
    repo: deps.repo,
    runManager: deps.runManager,
    events: deps.events,
    onReload: (agentId) => {
      // Channel mounts follow every spec reload (R08b); mount() serializes
      // per agent and never throws back into the host.
      void channels.mount(agentId).catch(() => {});
    },
    log: (agentId, message, level = 'info') =>
      deps.runManager.emit('log', agentId, {
        id: randomUUID(),
        agentId,
        timestamp: new Date().toISOString(),
        level,
        phase: 'trigger',
        message,
      } satisfies LogEntry),
  });
  // Channel mounts must exist before start(): start()'s initial reload of
  // every agent fires onReload, which is what mounts them.
  const channels = new ChannelTriggers({
    host: triggers,
    repo: deps.repo,
    buildAgent,
    resolve: secretResolver(deps.studio),
    log: (agentId, message, level) => triggers.log(agentId, message, level),
  });
  void triggers.start();
  // The cron scheduler fires `cron` triggers through the host on its own
  // interval; cursors persist under each agent's sidecar dir.
  const cron = new CronTriggers({ baseDir: deps.baseDir, host: triggers });
  cron.start();
  return { triggers, cron, channels };
}
