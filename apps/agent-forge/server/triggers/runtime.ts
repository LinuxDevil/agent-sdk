/**
 * The per-workspace trigger stack (R08a host + R08c cron scheduler),
 * built and started together so the workspace context and the legacy
 * app context behave identically: webhook/cron dispatches queue through
 * the workspace's own RunManager, and trigger-phase log lines land on
 * the same run-log stream RunManager's own entries use.
 */
import { randomUUID } from 'node:crypto';

import type { LogEntry } from '../../shared/wireTypes';
import type { AgentRepo } from '../storage/agentRepo';
import type { StudioEventBus } from '../events/eventBus';
import type { RunManager } from '../runRegistry';
import { CronTriggers } from './cronTriggers';
import { TriggerHost } from './triggerHost';

export interface TriggerRuntimeDeps {
  /** The workspace root (`ws.ref.root`); `.lousho/agents` hangs off it. */
  baseDir: string;
  repo: AgentRepo;
  runManager: RunManager;
  events: StudioEventBus;
}

export interface TriggerRuntime {
  triggers: TriggerHost;
  cron: CronTriggers;
}

export function createTriggerRuntime(deps: TriggerRuntimeDeps): TriggerRuntime {
  const triggers = new TriggerHost({
    repo: deps.repo,
    runManager: deps.runManager,
    events: deps.events,
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
  void triggers.start();
  // The cron scheduler fires `cron` triggers through the host on its own
  // interval; cursors persist under each agent's sidecar dir.
  const cron = new CronTriggers({ baseDir: deps.baseDir, host: triggers });
  cron.start();
  return { triggers, cron };
}
