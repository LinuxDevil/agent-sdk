/**
 * The tool Inspector's Behaviour section: the common controls every form
 * shows at the bottom — Approval, Load on demand and Node id. The hosted
 * and hub `ToolRef` variants cannot carry `approval`/`deferLoading`, so
 * those two controls only render for the forms that support them
 * (`supportsBehaviour`); Node id always renders.
 */
import type { ChangeEvent } from 'react';
import { InspectorSection } from '../../../components/InspectorSection';
import { Field } from '../../../ui/Field';
import { Input, Switch } from '../../../ui/controls';
import { TOOL_NODE_ID_PATTERN } from '../../../graph/v2/kinds/tool';
import type { ToolRef } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { supportsBehaviour, toolFormOf } from './toolForm';
import type { KindFieldsProps } from '../index';

type Approval = 'always' | 'never' | 'auto';

const APPROVAL_OPTIONS: { value: Approval; label: string }[] = [
  { value: 'always', label: 'Always ask' },
  { value: 'never', label: 'Never ask' },
  { value: 'auto', label: 'Let a model decide' },
];

/** Props for {@link BehaviourFields}: the whole `item` plus `patch`. */
export interface BehaviourFieldsProps {
  item: ToolRef;
  patch: KindFieldsProps<'tool'>['patch'];
}

/** The Behaviour section described above. */
export function BehaviourFields({ item, patch }: BehaviourFieldsProps): JSX.Element {
  const common = item as { approval?: Approval; deferLoading?: boolean };
  const id = item.id ?? '';
  const idError =
    id !== '' && !TOOL_NODE_ID_PATTERN.test(id)
      ? 'Use letters, digits, dash or underscore'
      : undefined;
  return (
    <InspectorSection id="tool-behaviour" title="Behaviour">
      {supportsBehaviour(toolFormOf(item)) && (
        <>
          <ChoiceField
            id="node-tool-approval"
            label="Approval"
            value={common.approval}
            allowUnset
            options={APPROVAL_OPTIONS}
            onChange={(approval) => patch({ approval })}
            help="Let a model decide asks a person only when the call looks risky."
            fieldPath=".approval"
          />
          <Field
            id="node-tool-defer"
            label="Load on demand"
            inline
            hint="The model finds it with tool search instead of seeing it up front."
            fieldPath=".deferLoading"
          >
            <Switch
              checked={common.deferLoading === true}
              onChange={(on) => patch({ deferLoading: on ? true : undefined })}
            />
          </Field>
        </>
      )}
      <Field
        id="node-tool-id"
        label="Node id"
        error={idError}
        hint="Optional. Keeps traces and layout stable if you rename the tool."
        fieldPath=".id"
      >
        <Input
          value={id}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ id: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
    </InspectorSection>
  );
}
