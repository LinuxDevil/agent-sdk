/**
 * The agent Inspector's Delegation section (C27, root agent only — an
 * inline subagent cannot delegate): `fields.subagentOptions`
 * (`SubagentOptions` minus `sessions`), `fields.maxSubagentDepth` and
 * `fields.maxHandoffs`.
 *
 * Deviation from the ticket table, per "the SDK wins": PLAN §3.1's
 * `subagentOptions.parallel`/`readOnly` do not exist — the SDK's object is
 * `{ maxConcurrent, awaitBackgroundOnFinish, background, continuation }`,
 * so the section edits those four real fields instead. Switch defaults
 * follow the SDK (`background`/`continuation` default on, so off writes
 * `false` and on deletes the key; `awaitBackgroundOnFinish` defaults off,
 * so on writes `true` and off deletes).
 */
import { Field } from '../../../ui/Field';
import { Switch } from '../../../ui/controls';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { AgentFields } from '../../../graph/v2/types';
import type { RunSettingsProps } from './LimitsSection';
import { mergeNested } from './mergeNested';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `subagentOptions` sub-key patch merged through `mergeNested`. */
function subagentPatch(fields: AgentFields, patch: Record<string, unknown>): Record<string, unknown> {
  return mergeNested(fields, 'subagentOptions', patch);
}

/** The Delegation section described above. */
export function DelegationFields({ fields, patch }: RunSettingsProps): JSX.Element {
  const options = isRecord(fields.subagentOptions) ? fields.subagentOptions : undefined;
  return (
    <>
      <OptionalNumberField
        id="node-agent-subagent-max-concurrent"
        label="Max concurrent subagents"
        value={options?.maxConcurrent as number | undefined}
        onChange={(maxConcurrent) => patch(subagentPatch(fields, { maxConcurrent }))}
        min={1}
        integer
        help="How many background sub-agents run at once (default 3)."
      />
      <Field
        id="node-agent-subagent-await-background"
        label="Wait for background subagents"
        inline
        hint="The run holds its answer until queued and running sub-agents finish."
      >
        <Switch
          checked={options?.awaitBackgroundOnFinish === true}
          onChange={(on) => patch(subagentPatch(fields, { awaitBackgroundOnFinish: on ? true : undefined }))}
        />
      </Field>
      <Field
        id="node-agent-subagent-background"
        label="Allow background subagents"
        inline
        hint="Off leaves only the synchronous task tool."
      >
        <Switch
          checked={options?.background !== false}
          onChange={(on) => patch(subagentPatch(fields, { background: on ? undefined : false }))}
        />
      </Field>
      <Field
        id="node-agent-subagent-continuation"
        label="Continue subagent conversations"
        inline
        hint="Off gives every task call a fresh conversation."
      >
        <Switch
          checked={options?.continuation !== false}
          onChange={(on) => patch(subagentPatch(fields, { continuation: on ? undefined : false }))}
        />
      </Field>
      <OptionalNumberField
        id="node-agent-max-subagent-depth"
        label="Max subagent depth"
        value={fields.maxSubagentDepth}
        onChange={(maxSubagentDepth) => patch({ maxSubagentDepth })}
        min={1}
        max={5}
        integer
        help="1 means subagents cannot start their own."
      />
      <OptionalNumberField
        id="node-agent-max-handoffs"
        label="Max handoffs"
        value={fields.maxHandoffs}
        onChange={(maxHandoffs) => patch({ maxHandoffs })}
        min={1}
        max={20}
        integer
      />
    </>
  );
}
