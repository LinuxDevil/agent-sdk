/**
 * `runDoctor`: the pure, testable core of `lousho doctor`. All access to the
 * outside world goes through the injected DoctorEnvironment.
 */
import {
  checkApiKeys,
  checkDocker,
  checkNode,
  checkOllama,
  checkOpenAIBaseUrl,
  checkOptionalPeers,
  checkPings,
  checkRequiredPeers,
} from './doctorChecks';
import { inspectSpec } from './doctorSpec';
import type { CheckStatus, DoctorCheck, DoctorEnvironment, DoctorReport } from './doctorTypes';

function summarize(checks: DoctorCheck[]): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

export interface DoctorOptions {
  /** `--ping`: GET `<base>/models` for each configured provider. */
  ping?: boolean;
}

/** Runs every check and returns the report; never throws for a bad setup. */
export async function runDoctor(env: DoctorEnvironment, options: DoctorOptions = {}): Promise<DoctorReport> {
  const spec = inspectSpec(env);
  const ollama = await checkOllama(env, spec.needs);
  const docker = await checkDocker(env, spec.needs);
  const baseUrl = checkOpenAIBaseUrl(env);
  const pings = options.ping ? await checkPings(env) : [];

  const checks: DoctorCheck[] = [
    checkNode(env),
    ...checkRequiredPeers(env),
    ...checkOptionalPeers(env, spec.needs),
    ...checkApiKeys(env, spec.needs),
    ...(baseUrl ? [baseUrl] : []),
    ...pings,
    ...spec.checks,
    ...(ollama ? [ollama] : []),
    docker,
  ];
  const summary = summarize(checks);
  return { checks, summary, exitCode: summary.fail > 0 ? 1 : 0 };
}
