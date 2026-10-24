/**
 * Monitoring alert hooks: fire-and-forget JSON POSTs to webhook URLs.
 *
 * Sources of config, merged by {@link resolveAlertConfig}:
 * - repeatable `--webhook <url>` on `lousho observe start`, and
 * - `alerts.json` beside the db: `{"webhooks": [...], "errorRateThreshold": n}`
 *   (n is a fraction 0..1 of today's runs that errored).
 *
 * The sweep (sweep.ts) produces {@link AlertEvent}s; {@link createAlerter}
 * delivers them. Delivery is deliberately dumb: plain `fetch`, a timeout so a
 * hung endpoint cannot pin the event loop, warn-once per webhook on failure,
 * and never a throw - alerting must not block ingest or the sweep (same rule
 * the reporter lives by: telemetry failure never fails a run).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SDKError } from '../execution/errors';

/** The alerts config file, read from the directory holding the observe db. */
const ALERTS_FILENAME = 'alerts.json';

/** A webhook call is abandoned after this; the sweep must not wait on a hung endpoint. */
const ALERT_TIMEOUT_MS = 5000;

/** One alert, POSTed verbatim as the JSON body to every configured webhook. */
export interface AlertEvent {
  /** 'agent.status' for a transition to 'down'; 'agent.error_rate' for a threshold crossing. */
  type: 'agent.status' | 'agent.error_rate';
  agent_id: string;
  project: string | null;
  /** 'down' for status alerts; the agent's current status for error-rate alerts. */
  status: string;
  /** Epoch milliseconds when the sweep fired it. */
  at: number;
  /** Alert-type-specific context (from-status, interrupted counts, rate vs threshold). */
  details: Record<string, unknown>;
}

export interface AlertConfig {
  webhooks: string[];
  /** Today's error rate at which an `agent.error_rate` alert fires (0..1); absent disables that alert. */
  errorRateThreshold?: number;
}

/** `alerts.json`'s path for a given db path (`observe.db` -> sibling `alerts.json`). */
function alertsPathFor(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), ALERTS_FILENAME);
}

/**
 * Read and validate an `alerts.json`. A missing file is just "no config";
 * a present-but-malformed file is a config error worth failing loudly on -
 * silently ignoring it would leave the owner thinking alerts are on.
 */
export function loadAlertsFile(filePath: string): AlertConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { webhooks: [] };
    throw new SDKError(`Could not read the alerts config at ${filePath}: ${(error as Error).message}`, 'LOUSHO_CONFIG_INVALID', {
      appendHelp: false,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SDKError(
      `The alerts config at ${filePath} is not valid JSON (expected {"webhooks": ["<url>", ...], "errorRateThreshold": 0.5}).`,
      'LOUSHO_CONFIG_INVALID',
      { appendHelp: false }
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SDKError(
      `The alerts config at ${filePath} must be a JSON object: {"webhooks": ["<url>", ...], "errorRateThreshold": 0.5}.`,
      'LOUSHO_CONFIG_INVALID',
      { appendHelp: false }
    );
  }
  const { webhooks: rawWebhooks, errorRateThreshold } = parsed as { webhooks?: unknown; errorRateThreshold?: unknown };
  const webhooks = rawWebhooks ?? [];
  if (!Array.isArray(webhooks) || webhooks.some((w) => typeof w !== 'string' || w.trim() === '')) {
    throw new SDKError(`The alerts config at ${filePath}: "webhooks" must be an array of URL strings.`, 'LOUSHO_CONFIG_INVALID', {
      appendHelp: false,
    });
  }
  if (
    errorRateThreshold !== undefined &&
    (typeof errorRateThreshold !== 'number' || !Number.isFinite(errorRateThreshold) || errorRateThreshold < 0 || errorRateThreshold > 1)
  ) {
    throw new SDKError(
      `The alerts config at ${filePath}: "errorRateThreshold" must be a number between 0 and 1 (a fraction of today's runs).`,
      'LOUSHO_CONFIG_INVALID',
      { appendHelp: false }
    );
  }
  return {
    webhooks: webhooks as string[],
    ...(errorRateThreshold !== undefined ? { errorRateThreshold } : {}),
  };
}

/**
 * The daemon's alert config: `alerts.json` beside the db merged with
 * `--webhook` flags (deduped). An in-memory db has no sibling file.
 */
export function resolveAlertConfig(dbPath: string, extraWebhooks: readonly string[] = []): AlertConfig {
  const file = dbPath === ':memory:' ? { webhooks: [] as string[] } : loadAlertsFile(alertsPathFor(dbPath));
  return {
    webhooks: [...new Set([...file.webhooks, ...extraWebhooks])],
    ...(file.errorRateThreshold !== undefined ? { errorRateThreshold: file.errorRateThreshold } : {}),
  };
}

export interface Alerter {
  /** POST every alert to every webhook. Fire-and-forget: never throws, never awaited by callers. */
  post(alerts: readonly AlertEvent[]): void;
}

/**
 * Fire-and-forget webhook delivery. A webhook that errors (network or
 * non-2xx) warns ONCE - a fleet going down at 3am must not fill the daemon's
 * log with one line per agent per sweep, and the webhook may simply be down.
 */
export function createAlerter(
  config: AlertConfig,
  fetchFn: typeof fetch = fetch,
  warn: (message: string) => void = (message) => console.warn(message)
): Alerter {
  const warned = new Set<string>();
  const warnOnce = (url: string, what: string): void => {
    if (warned.has(url)) return;
    warned.add(url);
    warn(`[lousho observe] alert webhook ${url} ${what}; alerts keep firing, this warning is only logged once.`);
  };
  return {
    post(alerts) {
      for (const url of config.webhooks) {
        for (const alert of alerts) {
          void fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(alert),
            signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
          })
            .then((res) => {
              if (!res.ok) warnOnce(url, `answered ${res.status}`);
            })
            .catch((error: unknown) => {
              warnOnce(url, `failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
      }
    },
  };
}
