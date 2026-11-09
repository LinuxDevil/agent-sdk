/**
 * The agent Inspector's Reliability section (C27): `fields.retry`
 * (`false` disables retries — a value, not "unset"), its Custom sub-fields
 * (`AgentSpecV2Retry`), and the `fields.rateLimit` caps
 * (`RateLimitOptions`).
 *
 * Deviation from the ticket table, per "the SDK wins": `retry.backoff` is
 * the SDK's `BackoffOptions` object (`{ initialMs, maxMs, factor, jitter }`,
 * always exponential — there is no 'linear' strategy), so the Backoff
 * choice writes preset `factor`s — Exponential 2, Linear 1 (a constant
 * delay, the closest the formula gets to linear) — merged over any custom
 * `BackoffOptions` sub-keys already in the spec. `rateLimit.maxConcurrent`
 * stays unedited here.
 */
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { AgentFields } from '../../../graph/v2/types';
import type { RunSettingsProps } from './LimitsSection';
import { mergeNested } from './mergeNested';

type RetryMode = 'off' | 'custom';
type BackoffChoice = 'exponential' | 'linear';

const RETRY_MODE_OPTIONS: { value: RetryMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'custom', label: 'Custom' },
];

const BACKOFF_OPTIONS: { value: BackoffChoice; label: string }[] = [
  { value: 'exponential', label: 'Exponential' },
  { value: 'linear', label: 'Linear' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The retry mode the ChoiceField shows: unset is Default, `false` is Off, an object is Custom. */
function retryModeOf(retry: AgentFields['retry']): RetryMode | undefined {
  if (retry === undefined) return undefined;
  return retry === false ? 'off' : 'custom';
}

/** The backoff preset the stored `BackoffOptions` reads as: `factor: 1` is the Linear preset, anything else Exponential. */
function backoffChoiceOf(backoff: unknown): BackoffChoice | undefined {
  if (!isRecord(backoff)) return undefined;
  return backoff.factor === 1 ? 'linear' : 'exponential';
}

/**
 * The `BackoffOptions` a Backoff choice writes: the preset's `factor`
 * merged over the stored object, so custom `initialMs`/`maxMs`/`jitter`
 * sub-keys (set in the spec file — the Inspector has no controls for them)
 * survive a re-pick. `undefined` deletes `retry.backoff`.
 */
function backoffValueOf(choice: BackoffChoice | undefined, existing: unknown): Record<string, unknown> | undefined {
  if (choice === undefined) return undefined;
  return { ...(isRecord(existing) ? existing : {}), factor: choice === 'linear' ? 1 : 2 };
}

/** The Reliability section described above. */
export function ReliabilityFields({ fields, patch }: RunSettingsProps): JSX.Element {
  const retry = fields.retry;
  const retryCustom = isRecord(retry) ? retry : undefined;
  const rateLimit = fields.rateLimit;
  return (
    <>
      <ChoiceField
        id="node-agent-retry"
        label="Retries"
        value={retryModeOf(retry)}
        options={RETRY_MODE_OPTIONS}
        allowUnset
        onChange={(mode) => {
          if (mode === undefined) patch({ retry: undefined });
          else if (mode === 'off') patch({ retry: false });
          else patch({ retry: retryCustom ?? {} });
        }}
      />
      {retryCustom !== undefined ? (
        <>
          <OptionalNumberField
            id="node-agent-retry-max"
            label="Max retries"
            value={retryCustom.maxRetries as number | undefined}
            onChange={(maxRetries) => patch(mergeNested(fields, 'retry', { maxRetries }))}
            min={0}
            max={10}
            integer
          />
          <ChoiceField
            id="node-agent-retry-backoff"
            label="Backoff"
            value={backoffChoiceOf(retryCustom.backoff)}
            options={BACKOFF_OPTIONS}
            allowUnset
            onChange={(backoff) =>
              patch(mergeNested(fields, 'retry', { backoff: backoffValueOf(backoff, retryCustom.backoff) }))
            }
          />
          <OptionalNumberField
            id="node-agent-retry-timeout"
            label="Timeout"
            value={retryCustom.timeoutMs as number | undefined}
            onChange={(timeoutMs) => patch(mergeNested(fields, 'retry', { timeoutMs }))}
            min={1000}
            integer
            unit="ms"
          />
        </>
      ) : null}
      <OptionalNumberField
        id="node-agent-rate-limit-rpm"
        label="Requests per minute"
        value={rateLimit?.requestsPerMinute}
        onChange={(requestsPerMinute) => patch(mergeNested(fields, 'rateLimit', { requestsPerMinute }))}
        min={1}
        integer
      />
      <OptionalNumberField
        id="node-agent-rate-limit-tpm"
        label="Tokens per minute"
        value={rateLimit?.tokensPerMinute}
        onChange={(tokensPerMinute) => patch(mergeNested(fields, 'rateLimit', { tokensPerMinute }))}
        min={1}
        integer
      />
    </>
  );
}
