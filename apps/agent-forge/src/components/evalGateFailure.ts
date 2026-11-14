import type { EvalGateResult, PublishGateFailure } from '../../shared/wireTypes';
import { RuntimeApiError } from '../runtime/runtimeClient';

/**
 * The pieces of a publish 409 `LOUSHO_EVAL_GATE_FAILED` the eval dialog
 * needs - `{ version, result }` - or `null` for any other error (X01b).
 * Shared by the publish pill and the versions tab's "Publish this".
 */
export function evalGateFailureOf(error: unknown): { version: number; result: EvalGateResult } | null {
  if (!(error instanceof RuntimeApiError) || error.status !== 409 || error.code !== 'LOUSHO_EVAL_GATE_FAILED') return null;
  const body = error.body as Partial<PublishGateFailure> | undefined;
  if (typeof body?.version !== 'number' || typeof body.details !== 'object' || body.details === null) return null;
  return { version: body.version, result: body.details as EvalGateResult };
}
