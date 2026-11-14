/**
 * The agent Inspector's Approvals section (C27): `fields.permissionMode`
 * (the SDK `PermissionMode` union — `dontAsk`, not PLAN §3.1's `bypass`),
 * `fields.approvalTtlMs` (the SDK accepts any positive number of ms; the
 * Inspector asks for at least 30 s, matching the human-question deadline
 * floor) and the `fields.askQuestion` switch.
 */
import { Field } from '../../../ui/Field';
import { Switch } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { AgentFields } from '../../../graph/v2/types';
import { MAX_APPROVAL_TTL_MS } from '../../../graph/v2/specTypes';
import type { RunSettingsProps } from './LimitsSection';

type PermissionMode = NonNullable<AgentFields['permissionMode']>;

const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan only' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'dontAsk', label: "Don't ask" },
];

/** The Approvals section described above. */
export function ApprovalsFields({ fields, patch }: RunSettingsProps): JSX.Element {
  return (
    <>
      <ChoiceField
        id="node-agent-permission-mode"
        label="Permission mode"
        value={fields.permissionMode ?? 'default'}
        options={PERMISSION_MODE_OPTIONS}
        onChange={(permissionMode) =>
          // 'default' is the SDK's own default: selecting it deletes the key rather than writing it.
          patch({ permissionMode: permissionMode === undefined || permissionMode === 'default' ? undefined : permissionMode })
        }
        help="Plan only refuses calls with side effects."
      />
      <OptionalNumberField
        id="node-agent-approval-ttl"
        label="Approval timeout"
        value={fields.approvalTtlMs}
        onChange={(approvalTtlMs) => patch({ approvalTtlMs })}
        min={30000}
        max={MAX_APPROVAL_TTL_MS}
        integer
        unit="ms"
        minMessage="At least 30 seconds"
        maxMessage="At most 100 years"
        help="Unanswered approvals are denied after this."
      />
      <Field
        id="node-agent-ask-question"
        label="Let the agent ask questions"
        inline
        hint="Adds the ask_question tool. Answers come from the Test pane or the Inbox."
      >
        <Switch
          checked={fields.askQuestion === true}
          onChange={(askQuestion) => patch({ askQuestion: askQuestion ? true : undefined })}
        />
      </Field>
    </>
  );
}
