/**
 * `RunOptionsSection` — the "Run options" Inspector section every
 * executable flow step (and `sequence`/`parallel`) shares: retry attempts,
 * the retry backoff (shown once attempts > 1) and the per-step time limit.
 * Writes go through `patch` on `data.step`: `retry` is replaced as a whole
 * object and deleted when Attempts is cleared; `timeoutMs` deletes on
 * empty.
 */
import type { NodeRetry } from '@linuxdevil/lousho/flows';
import { InspectorSection } from '../../../components/InspectorSection';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { KindFieldsProps } from '../index';
import type { StepRecord } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** `step.retry` read as the two editable numbers (absent → both undefined). */
function retryOf(step: StepRecord): { attempts: number | undefined; backoffMs: number | undefined } {
  const retry = step.retry as NodeRetry | undefined;
  return { attempts: retry?.maxAttempts, backoffMs: retry?.backoffMs };
}

/**
 * The `retry` patch for the two controls: `undefined` attempts clears the
 * whole `retry` object (the spec treats a missing retry as "no retries").
 */
function retryPatch(attempts: number | undefined, backoffMs: number | undefined): Record<string, unknown> {
  if (attempts === undefined) return { retry: undefined };
  const retry: NodeRetry = { maxAttempts: attempts };
  if (backoffMs !== undefined) retry.backoffMs = backoffMs;
  return { retry };
}

/** The Run options section body: Attempts, Wait before retry (attempts > 1), Time limit. */
export function RunOptionsSection({ node, patch }: Pick<FlowProps, 'node' | 'patch'>): JSX.Element {
  const step = node.data.step;
  const { attempts, backoffMs } = retryOf(step);
  const timeoutMs = typeof step.timeoutMs === 'number' ? step.timeoutMs : undefined;
  const id = `node-flow-${String(step.id)}`;

  return (
    <InspectorSection id="flow-run" title="Run options">
      <OptionalNumberField
        id={`${id}-attempts`}
        label="Attempts"
        value={attempts}
        min={1}
        max={10}
        integer
        help="Total tries, including the first."
        onChange={(next) => patch(retryPatch(next, next === undefined ? undefined : backoffMs))}
      />
      {attempts !== undefined && attempts > 1 && (
        <OptionalNumberField
          id={`${id}-backoff`}
          label="Wait before retry"
          value={backoffMs}
          min={0}
          integer
          unit="ms"
          help="Doubles after each retry."
          onChange={(next) => patch(retryPatch(attempts, next))}
        />
      )}
      <OptionalNumberField
        id={`${id}-timeout`}
        label="Time limit"
        value={timeoutMs}
        min={100}
        integer
        unit="ms"
        onChange={(next) => patch({ timeoutMs: next })}
      />
    </InspectorSection>
  );
}
