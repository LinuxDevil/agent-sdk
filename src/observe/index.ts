/**
 * Run and probe the observe collector from your own process — Studio
 * uses this to attach to or start the daemon.
 */
export { startObserveDaemon, probeHealth, isObserveDaemon, defaultDbPath, OBSERVE_RETENTION_DAYS_DEFAULT, OBSERVE_SESSION_IDLE_MINUTES_DEFAULT } from './daemon';
export type { ObserveDaemon, ObserveDaemonOptions, HealthProbe } from './daemon';
export { OBSERVE_DEFAULT_PORT } from './envelope';
