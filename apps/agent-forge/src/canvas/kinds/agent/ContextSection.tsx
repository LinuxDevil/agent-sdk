/**
 * The agent Inspector's Context section (C27): `fields.compaction`
 * (`boolean | AgentSpecV2Compaction` — `false` is a value, not "unset"),
 * `fields.promptCaching` (`'auto' | false`; the switch deletes the key for
 * the 'auto' default and writes `false` to disable), and `fields.toolSearch`
 * /`fields.codeMode`.
 *
 * Deviations from the ticket table, per "the SDK wins": the spec has no
 * `enabled` flag — `toolSearch` is `false | { thresholdPercent, maxResults,
 * contextWindow }` (only the literal `false` disables it; absent and `{}`
 * are both on) and `codeMode` is `boolean | CodeModeOptions` — so the
 * switches write `false`/`{}`/`true` for off/on and delete `codeMode`'s
 * key for off.
 */
import { Field } from '../../../ui/Field';
import { Switch } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { AgentFields } from '../../../graph/v2/types';
import type { RunSettingsProps } from './LimitsSection';
import { mergeNested } from './mergeNested';
import { ModelPicker } from './ModelPicker';

type CompactionMode = 'on' | 'off' | 'custom';

const COMPACTION_OPTIONS: { value: CompactionMode; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: 'custom', label: 'Custom' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The compaction mode the ChoiceField shows: unset is Default, booleans are On/Off, an object is Custom. */
function compactionModeOf(compaction: AgentFields['compaction']): CompactionMode | undefined {
  if (compaction === undefined) return undefined;
  if (compaction === true) return 'on';
  if (compaction === false) return 'off';
  return 'custom';
}

/** The Context section described above. */
export function ContextFields({ fields, patch }: RunSettingsProps): JSX.Element {
  const compaction = isRecord(fields.compaction) ? fields.compaction : undefined;
  const toolSearch = isRecord(fields.toolSearch) ? fields.toolSearch : undefined;
  const codeMode = fields.codeMode;
  return (
    <>
      <ChoiceField
        id="node-agent-compaction"
        label="Compaction"
        value={compactionModeOf(fields.compaction)}
        options={COMPACTION_OPTIONS}
        allowUnset
        onChange={(mode) => {
          if (mode === undefined) patch({ compaction: undefined });
          else if (mode === 'on') patch({ compaction: true });
          else if (mode === 'off') patch({ compaction: false });
          else patch({ compaction: compaction ?? {} });
        }}
        help="Summarises old turns when the context fills up."
      />
      {compaction !== undefined ? (
        <>
          <OptionalNumberField
            id="node-agent-compaction-threshold"
            label="Threshold"
            value={compaction.thresholdPercent as number | undefined}
            onChange={(thresholdPercent) => patch(mergeNested(fields, 'compaction', { thresholdPercent }))}
            min={0.1}
            max={1}
            step={0.05}
            help="Share of the context window, e.g. 0.8."
          />
          <ModelPicker
            id="node-agent-compaction-model"
            value={compaction.summarizer as string | undefined}
            onChange={(summarizer) => patch(mergeNested(fields, 'compaction', { summarizer }))}
          />
        </>
      ) : null}
      <Field
        id="node-agent-prompt-caching"
        label="Prompt caching"
        inline
      >
        <Switch
          checked={fields.promptCaching !== false}
          onChange={(on) => patch({ promptCaching: on ? undefined : false })}
        />
      </Field>
      <Field
        id="node-agent-tool-search"
        label="Tool search"
        inline
        hint="Loads deferred tools on demand."
      >
        <Switch
          // Only the literal `false` disables tool search; absent and `{}` both mean on.
          checked={fields.toolSearch !== false}
          onChange={(on) => patch({ toolSearch: on ? (toolSearch ?? {}) : false })}
        />
      </Field>
      {fields.toolSearch !== false ? (
        <OptionalNumberField
          id="node-agent-tool-search-max-results"
          label="Max results"
          value={(isRecord(fields.toolSearch) ? fields.toolSearch.maxResults : undefined) as number | undefined}
          onChange={(maxResults) => patch(mergeNested(fields, 'toolSearch', { maxResults }))}
          min={1}
          max={50}
          integer
        />
      ) : null}
      <Field
        id="node-agent-code-mode"
        label="Code mode"
        inline
        hint="Lets the model write a small program that calls tools."
      >
        <Switch
          checked={codeMode !== undefined && codeMode !== false}
          onChange={(on) => patch({ codeMode: on ? (isRecord(codeMode) ? codeMode : true) : undefined })}
        />
      </Field>
    </>
  );
}
