/**
 * The observe reporter a Studio run reports through - shared by the
 * playground (agent `playground`, playground.ts) and builder runs (agent =
 * the agent id, runRegistry.ts).
 *
 * Runs report to the daemon the Studio reads (`LOUSHO_OBSERVE_URL`, default
 * `http://127.0.0.1:7777`, the same target as observeProxy.ts) through the
 * SDK's own `observeExporter()`, so a daemon that is down only means the
 * reporter drops-and-counts; a run never waits on it or fails because of it.
 * When `LOUSHO_OBSERVE` is set for the studio process, its reporter is used
 * instead, so the run is not reported twice. Content (`gen_ai.*` messages,
 * tool arguments and results) is captured only for a loopback target.
 */
import {
  observeExporter,
  observeExporterFromEnv,
  type ObserveExporterOptions,
  type TraceExporter,
} from '@lousho/build-ai-agent/traces';
import { observeTarget } from './observeProxy';

/** One agent name's reporter and whether its runs may capture content. */
export interface ObserveReporting {
  /** The reporter for the next run; made on first use (no heartbeat until a run). */
  exporter: () => TraceExporter;
  /** True only when the reporter's target is a loopback daemon. */
  captureContent: () => boolean;
}

export interface ObserveReportingOptions {
  /** Every run reports under this agent name. */
  agentName: string;
  /** Project dir the reporter's `.lousho/identity/` lives under. */
  baseDir: string;
  /**
   * Reporter overrides (tests: `url`, `fetchFn`, `registerExitHooks`,
   * `flushIntervalMs`). Given, the `LOUSHO_OBSERVE` reporter is ignored. The
   * agent name stays `agentName`.
   */
  overrides?: Partial<ObserveExporterOptions>;
}

/** True for a `127.0.0.1` / `localhost` / `[::1]` URL. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Content capture defaults on for a loopback collector, as `createAgent` does under `LOUSHO_OBSERVE`. */
function envTargetIsLoopback(): boolean {
  const value = process.env.LOUSHO_OBSERVE?.trim() ?? '';
  return /^(1|true|on|yes)$/i.test(value) || isLoopbackUrl(value);
}

/** The observe reporting for runs under `options.agentName`. */
export function observeReporting(options: ObserveReportingOptions): ObserveReporting {
  let own: TraceExporter | undefined;
  const { agentName, overrides } = options;
  const url = () => overrides?.url ?? observeTarget();
  const fromEnv = () => (overrides ? undefined : observeExporterFromEnv({ agentName }));
  return {
    exporter: () =>
      fromEnv() ??
      (own ??= observeExporter({
        cwd: options.baseDir,
        // Parity with the LOUSHO_OBSERVE reporter: a daemon bound beyond loopback demands the bearer.
        ...(process.env.LOUSHO_OBSERVE_TOKEN ? { token: process.env.LOUSHO_OBSERVE_TOKEN } : {}),
        ...overrides,
        url: url(),
        agentName,
      })),
    captureContent: () => (fromEnv() ? envTargetIsLoopback() : isLoopbackUrl(url())),
  };
}
