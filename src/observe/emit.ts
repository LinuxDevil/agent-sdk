/**
 * `emitObserveEvents()` - the event post path for emitters that are not the
 * span reporter: eval scores land when a case finishes, not when a span ends,
 * so `src/evals` needs a way to POST ingest events on its own cadence.
 *
 * The rules mirror the reporter's (src/observe/reporter.ts) because the
 * contract is the same:
 * - `LOUSHO_OBSERVE` decides where events go: `1`/`true` -> the loopback
 *   default, a URL -> that collector, unset/`0`/`false`/`off` -> nothing is sent
 *   ({@link observeTargetFromEnv} returns `undefined`).
 * - One `POST /api/v1/ingest` per call, `{ batch: [...] }` as the envelope
 *   declares; the daemon's ingest is the only write path.
 * - Drop, never throw: an unreachable daemon or a non-2xx answer warns ONCE
 *   and resolves 0. An eval run, a human feedback widget, anything calling
 *   this must never fail because telemetry did.
 * - The POST is plain `fetch` outside any span, like the reporter's own.
 */

import { SDKError } from '../execution/errors';
import { OBSERVE_DEFAULT_PORT, type IngestEvent } from './envelope';

/** Where events go: the collector's base URL plus its optional bearer token. */
export interface ObserveTarget {
  url: string;
  token?: string;
  /** The project label the reporter stamps; emitters resolving agent identity want the same value. */
  project?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

const OFF_WORDS = new Set(['', '0', 'false', 'off', 'no', 'none', 'disabled']);
const ON_WORDS = new Set(['1', 'true', 'on', 'yes']);
let warnedInvalidFlag = false;

/** Test hook: re-arm the once-per-process invalid `LOUSHO_OBSERVE` warning. */
export function resetObserveEnvWarning(): void {
  warnedInvalidFlag = false;
}

/**
 * The collector `LOUSHO_OBSERVE` points at, with the same resolution the
 * reporter applies (`observeExporterFromEnv`): `1`/`true`/`on`/`yes` -> the
 * loopback daemon (`LOUSHO_OBSERVE_PORT`, default 7777), an `http(s)://` URL
 * -> that collector, unset/`0`/`false`/`off`/`no`/`none`/`disabled`
 * (any case) -> `undefined` (emission is off). Anything else is a typo: it
 * warns once per process and disables, rather than being posted to as a URL.
 *
 * `lousho eval --observe` sets `LOUSHO_OBSERVE=1` inside the vitest worker
 * when the variable is unset, so this one check covers both the env-driven
 * and the forced case.
 */
export function observeTargetFromEnv(env: NodeJS.ProcessEnv | undefined = typeof process !== 'undefined' ? process.env : undefined): ObserveTarget | undefined {
  const flag = env?.LOUSHO_OBSERVE?.trim();
  if (!env || flag === undefined) return undefined;
  const word = flag.toLowerCase();
  if (OFF_WORDS.has(word)) return undefined;
  let url: string;
  if (ON_WORDS.has(word)) {
    url = `http://127.0.0.1:${env.LOUSHO_OBSERVE_PORT || String(OBSERVE_DEFAULT_PORT)}`;
  } else if (/^https?:\/\//i.test(flag)) {
    url = flag;
  } else {
    if (!warnedInvalidFlag) {
      warnedInvalidFlag = true;
      console.warn(
        `[lousho observe] ignoring LOUSHO_OBSERVE=${JSON.stringify(flag)}: expected 1/true/on/yes, an http(s):// URL, or 0/false/off/no/none/disabled. Reporting is disabled.`
      );
    }
    return undefined;
  }
  return {
    url: url.replace(/\/+$/, ''),
    ...(env.LOUSHO_OBSERVE_TOKEN ? { token: env.LOUSHO_OBSERVE_TOKEN } : {}),
    ...(env.LOUSHO_OBSERVE_PROJECT ? { project: env.LOUSHO_OBSERVE_PROJECT } : {}),
  };
}

/**
 * Whether `target` is this machine's own collector (host `127.0.0.1`,
 * `localhost` or `::1`). A loopback collector is auth-free and its db never
 * leaves the machine, so content capture defaults on for it.
 */
export function isLoopbackTarget(target: ObserveTarget): boolean {
  try {
    const host = new URL(target.url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * The `captureContent` an agent runs with: the explicit setting when there is
 * one, else on when the env collector is loopback, else `undefined` (the
 * executor then follows the OTel content env var).
 */
export function defaultCaptureContent(explicit: boolean | undefined, env?: NodeJS.ProcessEnv): boolean | undefined {
  if (explicit !== undefined) return explicit;
  const target = observeTargetFromEnv(env);
  return target && isLoopbackTarget(target) ? true : undefined;
}

export interface EmitObserveOptions {
  /** Explicit target; default the env's (`observeTargetFromEnv`). */
  target?: ObserveTarget;
  /** Env to resolve the target from when `target` is absent (tests). */
  env?: NodeJS.ProcessEnv;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-request timeout (default 5000ms). */
  timeoutMs?: number;
}

let warned = false;

/**
 * POST `events` as one ingest batch and resolve with the count delivered
 * (0 when emission is off or the POST failed). Never throws: failures warn
 * once, like the reporter.
 */
export async function emitObserveEvents(events: readonly IngestEvent[], options: EmitObserveOptions = {}): Promise<number> {
  const target = options.target ?? observeTargetFromEnv(options.env);
  if (target === undefined || events.length === 0) return 0;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.token) headers.authorization = `Bearer ${target.token}`;
  try {
    const res = await (options.fetchFn ?? fetch)(`${target.url}/api/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ batch: [...events] }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SDKError(`ingest answered ${res.status}`, 'LOUSHO_REMOTE_REQUEST_FAILED', { appendHelp: false });
    }
    return events.length;
  } catch (error) {
    if (!warned) {
      warned = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[lousho] observe: could not reach the observe daemon at ${target.url} (${reason}); ${events.length} event(s) dropped and the run is unaffected.`
      );
    }
    return 0;
  }
}

/** One-event convenience over {@link emitObserveEvents}. */
export function emitObserveEvent(event: IngestEvent, options: EmitObserveOptions = {}): Promise<number> {
  return emitObserveEvents([event], options);
}
