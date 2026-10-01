import type { AgentSpec } from '../spec/schema';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One diagnostic line: what was checked, what was found, and (when not ok) how to fix it. */
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  /** What was checked, e.g. "Node.js". */
  title: string;
  /** What was found. Never contains an API key value. */
  finding: string;
  /** A command to run or a setting to change; present for warn/fail. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: Record<CheckStatus, number>;
  /** 1 if any check failed, 0 otherwise (warnings do not fail). */
  exitCode: 0 | 1;
}

/** The subset of the SDK's own package.json that the doctor reads at runtime. */
export interface SdkManifest {
  engines?: { node?: string };
  peerDependencies?: Record<string, string>;
}

/**
 * Everything `runDoctor` needs from the outside world. The real
 * implementation lives in doctor.ts; tests inject plain objects.
 */
export interface DoctorEnvironment {
  /** Node version without the leading "v", e.g. "22.19.0". */
  nodeVersion: string;
  env: Record<string, string | undefined>;
  sdk: SdkManifest;
  /** Installed version of `name` resolved from the user's cwd, or null when not installed. */
  resolvePackageVersion(name: string): string | null;
  /** Agent spec path given on the command line, if any. */
  specPath?: string;
  /** Loads and validates a spec (the SDK's own loader); throws with field paths on invalid input. */
  loadSpec(path: string): AgentSpec;
  /** Resolves a built-in tool name; throws if unknown. */
  resolveTool(name: string): { requiresSandbox?: boolean };
  /** True when `command` is an existing file or is found on PATH. */
  commandExists(command: string): boolean;
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; status: number }>;
  /** True when a Docker daemon answers a ping. */
  dockerReachable(): Promise<boolean>;
}
