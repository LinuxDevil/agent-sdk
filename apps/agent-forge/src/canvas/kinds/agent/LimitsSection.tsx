/**
 * The agent Inspector's Limits section (C27): `fields.maxSteps` plus the
 * `fields.limits` budget (`RunLimits` in src/execution/budget.ts — the SDK's
 * field names win over the ticket table). Nested writes go through
 * `mergeNested`, which drops `limits` once its last sub-key is cleared.
 */
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { AgentFields } from '../../../graph/v2/types';
import type { KindFieldsProps } from '../index';
import { mergeNested } from './mergeNested';

type Patch = KindFieldsProps<'agent'>['patch'];

/** Props of the run-settings section bodies. */
export interface RunSettingsProps {
  fields: AgentFields;
  patch: Patch;
}

const ON_EXCEEDED_OPTIONS: { value: 'stop' | 'throw'; label: string }[] = [
  { value: 'stop', label: 'Stop the run' },
  { value: 'throw', label: 'Fail with an error' },
];

/** The Limits section described above. */
export function LimitsFields({ fields, patch }: RunSettingsProps): JSX.Element {
  const limits = fields.limits;
  return (
    <>
      <OptionalNumberField
        id="node-agent-max-steps"
        label="Max steps"
        value={fields.maxSteps}
        onChange={(maxSteps) => patch({ maxSteps })}
        min={1}
        max={500}
        integer
        help="Model turns per run before it stops."
      />
      <OptionalNumberField
        id="node-agent-max-cost"
        label="Max cost (USD)"
        value={limits?.maxCostUsd}
        onChange={(maxCostUsd) => patch(mergeNested(fields, 'limits', { maxCostUsd }))}
        min={0.01}
        max={1000}
        step={0.01}
        help="Includes subagent spend."
      />
      <OptionalNumberField
        id="node-agent-max-tokens"
        label="Max tokens"
        value={limits?.maxTokens}
        onChange={(maxTokens) => patch(mergeNested(fields, 'limits', { maxTokens }))}
        min={1}
        integer
      />
      <OptionalNumberField
        id="node-agent-max-duration"
        label="Max duration"
        value={limits?.maxDurationMs}
        onChange={(maxDurationMs) => patch(mergeNested(fields, 'limits', { maxDurationMs }))}
        min={1000}
        integer
        unit="ms"
      />
      <OptionalNumberField
        id="node-agent-max-tool-errors"
        label="Max tool errors"
        value={limits?.maxToolErrors}
        onChange={(maxToolErrors) => patch(mergeNested(fields, 'limits', { maxToolErrors }))}
        min={1}
        integer
      />
      <ChoiceField
        id="node-agent-on-exceeded"
        label="When a limit is hit"
        value={limits?.onExceeded}
        options={ON_EXCEEDED_OPTIONS}
        allowUnset
        onChange={(onExceeded) => patch(mergeNested(fields, 'limits', { onExceeded }))}
      />
    </>
  );
}
