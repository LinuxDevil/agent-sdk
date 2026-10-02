/**
 * `runDoctor`: the pure, testable core of `lousho doctor`. All access to the
 * outside world goes through the injected DoctorEnvironment.
 */
import {
  checkApiKeys,
  checkDocker,
  checkNode,
  checkOllama,
  checkOptionalPeers,
  checkRequiredPeers,
} from './doctorChecks';
import { inspectSpec } from './doctorSpec';
import type { CheckStatus, DoctorCheck, DoctorEnvironment, DoctorReport } from './doctorTypes';

function summarize(checks: DoctorCheck[]): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

/** Runs every check and returns the report; never throws for a bad setup. */
export async function runDoctor(env: DoctorEnvironment): Promise<DoctorReport> {
  const spec = inspectSpec(env);
  const ollama = await checkOllama(env, spec.needs);
  const docker = await checkDocker(env, spec.needs);

  const checks: DoctorCheck[] = [
    checkNode(env),
    ...checkRequiredPeers(env),
    ...checkOptionalPeers(env, spec.needs),
    ...checkApiKeys(env, spec.needs),
    ...spec.checks,
    ...(ollama ? [ollama] : []),
    docker,
  ];
  const summary = summarize(checks);
  return { checks, summary, exitCode: summary.fail > 0 ? 1 : 0 };
}
