/**
 * The collector (observe daemon) Studio talks to - one place that decides
 * which daemon the `/observe` proxy, run reporting, the judge loop and
 * (later) project bridges all use.
 *
 * On `start()` Studio attaches to the daemon already answering at the
 * effective URL, or - for a loopback URL with nothing there and
 * `autoStart` on - starts one in its own process (`startObserveDaemon`,
 * never with `pidPath`, so `lousho observe stop` can't kill Studio's) and
 * closes it again on `stop()`. A remote URL that doesn't answer is
 * reported `down` and re-probed every {@link COLLECTOR_REPROBE_MS}.
 *
 * Precedence: URL = env `LOUSHO_OBSERVE_URL` > `settings.json`'s
 * `collector.url` > {@link DEFAULT_COLLECTOR_URL}. Token = env
 * `LOUSHO_OBSERVE_TOKEN` > the D13 named secret of the same name > none.
 * The token is a secret: it is never returned in a status, never logged,
 * never put in a URL.
 */
import {
  defaultDbPath,
  isObserveDaemon,
  startObserveDaemon,
  type HealthProbe,
  type ObserveDaemon,
  type ObserveDaemonOptions,
} from 'lousho/observe';
import { VERSION } from 'lousho';
import type { CollectorStatus, CollectorUpdate } from '../shared/wireTypes';
import type { SecretsStore } from './secretsStore';
import type { SettingsStore } from './settingsStore';
import { isLoopbackUrl } from './observeReporting';

export const DEFAULT_COLLECTOR_URL = 'http://127.0.0.1:7777';
/** The D13 named secret (and env var) holding the collector's bearer token. */
export const COLLECTOR_TOKEN_SECRET = 'LOUSHO_OBSERVE_TOKEN';
/** How often a `down` collector is re-probed (probe only - never a restart loop). */
// fallow-ignore-next-line unused-export -- W12 contract: the down-state re-probe cadence
export const COLLECTOR_REPROBE_MS = 30_000;

const PROBE_TIMEOUT_MS = 2000;
const MAX_URL_LENGTH = 2048;
const ENV_URL = 'LOUSHO_OBSERVE_URL';
const ENV_TOKEN = 'LOUSHO_OBSERVE_TOKEN';
const ENV_DISABLE = 'LOUSHO_STUDIO_COLLECTOR';

/** The two getters every collector consumer reads per call. */
export interface CollectorSource {
  url(): string;
  token(): string | undefined;
}

export interface CollectorDeps {
  settings: SettingsStore;
  secrets: SecretsStore;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the SDK's `startObserveDaemon`. */
  startDaemon?: (options: ObserveDaemonOptions) => Promise<ObserveDaemon>;
  /** Test seam; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Default true; false when `LOUSHO_STUDIO_COLLECTOR === '0'` or `startStudioServer({ collector: false })`. */
  autoStart?: boolean;
}

/** `PUT /settings/collector` was refused because `LOUSHO_OBSERVE_URL` locks the URL (route maps to 409). */
export class CollectorLockedError extends Error {}

/** `PUT /settings/collector`'s `url` failed validation (route maps to 400). */
export class CollectorUrlError extends Error {}

/** `null`, or an `http:`/`https:` URL with no path other than `/`, no query, at most 2048 chars. */
// fallow-ignore-next-line unused-export -- the PUT route's URL rule, exported for tests and future callers
export function isValidCollectorUrl(raw: string | null): raw is string | null {
  if (raw === null) return true;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && (url.pathname === '/' || url.pathname === '') && url.search === '';
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

/** `GET <url>/health` with the token as bearer when set; the daemon's HealthProbe, or undefined when nothing usable answers. */
// fallow-ignore-next-line unused-export -- the health probe behind probe()/start(), exported for tests
export async function probeUrl(
  url: string,
  token: string | undefined,
  fetchFn: typeof fetch = fetch
): Promise<HealthProbe | undefined> {
  try {
    const res = await fetchFn(`${trimSlashes(url)}/health`, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const health = (await res.json()) as HealthProbe;
    return isObserveDaemon(health) ? health : undefined;
  } catch {
    return undefined;
  }
}

/** Two collector URLs name the same daemon when scheme, port and a loopback-normalised host agree. */
function sameCollectorUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const host = (u: URL) => (isLoopbackUrl(u.origin) ? 'loopback' : u.hostname.toLowerCase());
    return ua.protocol === ub.protocol && ua.port === ub.port && host(ua) === host(ub);
  } catch {
    return a === b;
  }
}

interface ResolvedTarget {
  url: string;
  configuredUrl: string | null;
  lockedByEnv: boolean;
}

/**
 * The collector in effect. `start()` attaches or starts the daemon;
 * `reconfigure()` persists a Settings change and re-runs `start()`;
 * `probe()` re-checks the URL without ever starting a daemon; while
 * `down`, a timer re-probes every {@link COLLECTOR_REPROBE_MS}.
 */
export class CollectorManager implements CollectorSource {
  private readonly deps: Required<Pick<CollectorDeps, 'env' | 'fetchFn' | 'autoStart'>> &
    Pick<CollectorDeps, 'settings' | 'secrets' | 'startDaemon'>;
  private current: CollectorStatus;
  private daemon: ObserveDaemon | undefined;
  /** The effective URL the started daemon was launched for (the reconfigure comparison). */
  private startedForUrl: string | undefined;
  private reprobeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(status: CollectorStatus) => void>();

  constructor(deps: CollectorDeps) {
    const env = deps.env ?? process.env;
    this.deps = {
      settings: deps.settings,
      secrets: deps.secrets,
      env,
      fetchFn: deps.fetchFn ?? fetch,
      autoStart: deps.autoStart ?? env[ENV_DISABLE] !== '0',
      startDaemon: deps.startDaemon,
    };
    const resolved = this.resolve();
    this.current = {
      mode: 'down',
      url: resolved.url,
      configuredUrl: resolved.configuredUrl,
      lockedByEnv: resolved.lockedByEnv,
      hasToken: this.token() !== undefined,
      daemonVersion: null,
      error: null,
    };
  }

  /** env `LOUSHO_OBSERVE_URL` > settings `collector.url` > the loopback default; env also locks the setting. */
  private resolve(): ResolvedTarget {
    const envUrl = this.deps.env[ENV_URL]?.trim();
    const configuredUrl = this.deps.settings.getCollectorUrl();
    if (envUrl) {
      return { url: trimSlashes(envUrl), configuredUrl, lockedByEnv: true };
    }
    return { url: trimSlashes(configuredUrl ?? DEFAULT_COLLECTOR_URL), configuredUrl, lockedByEnv: false };
  }

  /** env `LOUSHO_OBSERVE_TOKEN` > the named secret > none; resolved live so a secrets-UI write takes effect. */
  token(): string | undefined {
    return this.deps.env[ENV_TOKEN] || this.deps.secrets.getSecret(COLLECTOR_TOKEN_SECRET) || undefined;
  }

  /** The effective URL right now (env > settings > default), re-resolved per call like `token()`. */
  url(): string {
    return this.resolve().url;
  }

  status(): CollectorStatus {
    return this.current;
  }

  private setStatus(patch: Partial<CollectorStatus>): void {
    const next: CollectorStatus = { ...this.current, ...patch, hasToken: this.token() !== undefined };
    const changed =
      next.mode !== this.current.mode ||
      next.url !== this.current.url ||
      next.error !== this.current.error ||
      next.daemonVersion !== this.current.daemonVersion ||
      next.hasToken !== this.current.hasToken ||
      next.lockedByEnv !== this.current.lockedByEnv ||
      next.configuredUrl !== this.current.configuredUrl;
    this.current = next;
    if (changed) for (const listener of this.listeners) listener(next);
  }

  // fallow-ignore-next-line unused-class-member -- W12 contract: status-change subscription for routes/UI
  onChange(listener: (status: CollectorStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resolvedFields(): Pick<CollectorStatus, 'url' | 'configuredUrl' | 'lockedByEnv'> {
    const resolved = this.resolve();
    return { url: resolved.url, configuredUrl: resolved.configuredUrl, lockedByEnv: resolved.lockedByEnv };
  }

  /** Probe the effective URL and record attached/remote/down; never starts a daemon. */
  async probe(): Promise<CollectorStatus> {
    const fields = this.resolvedFields();
    const health = await probeUrl(fields.url, this.token(), this.deps.fetchFn);
    this.clearReprobe();
    if (health) {
      this.setStatus({
        ...fields,
        mode: this.daemon ? 'started' : isLoopbackUrl(fields.url) ? 'attached' : 'remote',
        daemonVersion: health.version ?? (this.daemon ? VERSION : null),
        error: null,
      });
    } else {
      this.setStatus({ ...fields, mode: 'down', daemonVersion: null, error: `No collector answered at ${fields.url}.` });
      this.scheduleReprobe();
    }
    return this.current;
  }

  /** Attach to the answering daemon, or start one on a loopback URL; resolves the status either way (never throws for a down collector). */
  async start(): Promise<CollectorStatus> {
    await this.probe();
    if (this.current.mode !== 'down' || this.daemon || !this.deps.autoStart || !isLoopbackUrl(this.current.url)) {
      return this.current;
    }
    const port = Number(new URL(this.current.url).port || '7777');
    const startDaemon = this.deps.startDaemon ?? startObserveDaemon;
    try {
      this.daemon = await startDaemon({ port, host: '127.0.0.1', dbPath: defaultDbPath() });
      this.startedForUrl = this.current.url;
      this.clearReprobe();
      this.setStatus({ mode: 'started', daemonVersion: VERSION, error: null });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.setStatus({
        mode: 'down',
        daemonVersion: null,
        error:
          code === 'EADDRINUSE'
            ? `Port ${port} is in use by something that is not a Lousho collector. Free the port or point Studio at another collector in Settings → Collector.`
            : error instanceof Error
              ? error.message
              : String(error),
      });
      this.scheduleReprobe();
    }
    return this.current;
  }

  /**
   * Persist a Settings → Collector change and re-resolve. `lockedByEnv`
   * refuses with {@link CollectorLockedError}; a bad `url` with
   * {@link CollectorUrlError}. A daemon this Studio started is closed
   * when the new URL is not the one it was started for.
   */
  async reconfigure(update: CollectorUpdate): Promise<CollectorStatus> {
    if (this.current.lockedByEnv) {
      throw new CollectorLockedError('LOUSHO_OBSERVE_URL is set in Studio\'s environment, so this setting is ignored.');
    }
    if (!isValidCollectorUrl(update.url)) {
      throw new CollectorUrlError('Enter an http or https URL without a path, or leave it empty to use this machine.');
    }
    if (update.token !== undefined && update.token !== null && (typeof update.token !== 'string' || !update.token.trim())) {
      throw new CollectorUrlError('Enter a non-empty bearer token, or leave it empty to keep the saved one.');
    }
    this.deps.settings.setCollectorUrl(update.url);
    if (update.token === null) this.deps.secrets.removeSecret(COLLECTOR_TOKEN_SECRET);
    else if (update.token !== undefined) this.deps.secrets.setSecret(COLLECTOR_TOKEN_SECRET, update.token);

    const next = this.resolve().url;
    if (this.daemon && this.startedForUrl !== undefined && !sameCollectorUrl(next, this.startedForUrl)) {
      const daemon = this.daemon;
      this.daemon = undefined;
      this.startedForUrl = undefined;
      await daemon.close();
    }
    return this.start();
  }

  private scheduleReprobe(): void {
    if (this.reprobeTimer !== undefined) return;
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = undefined;
      void this.probe();
    }, COLLECTOR_REPROBE_MS);
    this.reprobeTimer.unref();
  }

  private clearReprobe(): void {
    if (this.reprobeTimer !== undefined) {
      clearTimeout(this.reprobeTimer);
      this.reprobeTimer = undefined;
    }
  }

  /** Closes a daemon this Studio started; never touches one it attached to. */
  // fallow-ignore-next-line unused-class-member -- called as `handle.collector.stop()` in server/index.ts close()
  async stop(): Promise<void> {
    this.clearReprobe();
    const daemon = this.daemon;
    this.daemon = undefined;
    this.startedForUrl = undefined;
    if (daemon) await daemon.close();
  }
}
