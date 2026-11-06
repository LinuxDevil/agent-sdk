/**
 * The MCP Inspector's behaviour fields — the controls both transports
 * share: approval mode, load on demand, optional, and the two timeouts.
 */
import { Field } from '../../../ui/Field';
import { Switch } from '../../../ui/controls';
import type { McpServerSpec } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { KindFieldsProps } from '../index';

/** Props for {@link McpBehaviour}: the whole `item` plus `patch`. */
export interface McpBehaviourProps {
  item: McpServerSpec;
  patch: KindFieldsProps<'mcp'>['patch'];
}

type Approval = 'annotations' | 'never';

const APPROVAL_OPTIONS: { value: Approval; label: string }[] = [
  { value: 'annotations', label: "Use the server's tool hints" },
  { value: 'never', label: 'Never ask' },
];

/** The behaviour fields described above. */
export function McpBehaviour({ item, patch }: McpBehaviourProps): JSX.Element {
  // The SDK's McpApproval also admits a function form; a spec can only
  // carry the string modes, so anything else renders as unset.
  const approval = item.approval === 'annotations' || item.approval === 'never' ? item.approval : undefined;
  return (
    <>
      <ChoiceField
        id="node-mcp-approval"
        label="Approval"
        value={approval}
        options={APPROVAL_OPTIONS}
        onChange={(next) => patch({ approval: next })}
        allowUnset
        unsetLabel="Always ask"
        help="Tool hints ask only for tools marked destructive."
      />
      <Field id="node-mcp-defer" label="Load on demand" inline>
        <Switch
          checked={item.deferLoading === true}
          onChange={(on) => patch({ deferLoading: on ? true : undefined })}
        />
      </Field>
      <Field
        id="node-mcp-optional"
        label="Optional"
        inline
        hint="Start the agent even if this server fails."
      >
        <Switch
          checked={item.optional === true}
          onChange={(on) => patch({ optional: on ? true : undefined })}
        />
      </Field>
      <OptionalNumberField
        id="node-mcp-timeout"
        label="Timeout"
        value={item.timeoutMs}
        onChange={(timeoutMs) => patch({ timeoutMs })}
        integer
        min={1000}
        unit="ms"
      />
      <OptionalNumberField
        id="node-mcp-connect-timeout"
        label="Connect timeout"
        value={item.connectTimeoutMs}
        onChange={(connectTimeoutMs) => patch({ connectTimeoutMs })}
        integer
        min={1000}
        unit="ms"
      />
    </>
  );
}
