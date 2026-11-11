/**
 * `FlowMetaSection` — the "Flow settings" Inspector section shown only on
 * the flow root step: code, name, description, the inputs rows editor and
 * the advanced `agents` JSON. Writes go through `patchFlowMeta` (the
 * `AgentFlow` wrapper fields live in `data.flowMeta`, outside `data.step`).
 */
import type { ChangeEvent } from 'react';
import { InspectorSection } from '../../../components/InspectorSection';
import { Field } from '../../../ui/Field';
import { Input, Textarea } from '../../../ui/controls';
import { JsonField } from '../../fields/JsonField';
import type { AgentFlow, FlowInputVariable } from 'lousho/flows';
import type { KindFieldsProps } from '../index';
import { FLOW_CODE_PATTERN } from './flowForm';
import { FlowInputsEditor } from './FlowInputsEditor';

type FlowProps = KindFieldsProps<'flow'>;

/** `flowMeta` as a record for reads (it is `Omit<AgentFlow, 'flow'>`). */
function metaOf(node: FlowProps['node']): Record<string, unknown> {
  return (node.data.flowMeta ?? {}) as unknown as Record<string, unknown>;
}

/** The Flow settings section (root step only — the caller gates on `flowMeta`). */
export function FlowMetaSection({ node, patchFlowMeta }: FlowProps): JSX.Element | null {
  const meta = metaOf(node);
  if (node.data.flowMeta === undefined || patchFlowMeta === undefined) return null;
  const patch = patchFlowMeta;
  const base = `node-flow-${String(node.data.step.id)}`;
  const code = typeof meta.code === 'string' ? meta.code : '';
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description : '';

  return (
    <InspectorSection id="flow-meta" title="Flow settings">
      <Field
        id={`${base}-code`}
        label="Code"
        required={code === ''}
        error={
          code === ''
            ? 'Required'
            : FLOW_CODE_PATTERN.test(code)
              ? undefined
              : 'Use lower-case letters, digits and dash'
        }
        hint="Identifies durable runs. Changing it orphans paused runs."
      >
        <Input
          className="mono"
          value={code}
          onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ code: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <Field id={`${base}-name`} label="Name" required={name === ''} error={name === '' ? 'Required' : undefined}>
        <Input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value === '' ? undefined : e.target.value })} />
      </Field>
      <Field id={`${base}-description`} label="Description">
        <Textarea
          rows={2}
          value={description}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patch({ description: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <FlowInputsEditor
        id={`${base}-inputs`}
        inputs={meta.inputs}
        onChange={(inputs: FlowInputVariable[] | undefined) => patch({ inputs })}
      />
      <JsonField
        id={`${base}-agents`}
        label="Flow agents"
        value={meta.agents}
        rows={4}
        check={(v) => (v === undefined || Array.isArray(v) ? undefined : 'Use a JSON list')}
        help="Advanced: FlowAgentDefinition list."
        onChange={(next) => patch({ agents: next as AgentFlow['agents'] })}
      />
    </InspectorSection>
  );
}
