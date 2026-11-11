/**
 * `ToolCallForm` — the `toolCall` step's Inspector body: the tool picker
 * (the root agent's own tool node names, plus "Other…" free text), the
 * JSON arguments object and the output variable.
 */
import { useState, type ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Select } from '../../../ui/controls';
import { JsonField } from '../../fields/JsonField';
import { rootToolNameList } from '../../../graph/v2/kinds/flow';
import type { KindFieldsProps } from '../index';
import { OutputVariableField } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The select value meaning "type a tool name by hand". */
const OTHER = '__other__';

/** The tool `Select` + "Other…" input: catalog names first, free text for anything else. */
function ToolField({ id, step, graph, patch }: { id: string; step: FlowProps['node']['data']['step']; graph: FlowProps['graph']; patch(p: Record<string, unknown>): void }): JSX.Element {
  const names = rootToolNameList(graph);
  const value = typeof step.tool === 'string' ? step.tool : '';
  const known = value !== '' && names.includes(value);
  const [other, setOther] = useState(value !== '' && !known);

  const onSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (next === OTHER) {
      setOther(true);
      patch({ tool: undefined });
      return;
    }
    setOther(false);
    patch({ tool: next });
  };

  const onText = (e: ChangeEvent<HTMLInputElement>) => {
    patch({ tool: e.target.value === '' ? undefined : e.target.value });
  };

  return (
    <Field id={id} label="Tool" required={value === ''} error={value === '' ? 'Required' : undefined}>
      {other || (value !== '' && !known) ? (
        <Input className="mono" value={value} placeholder="tool name" onChange={onText} />
      ) : (
        <Select
          value={value}
          placeholder="Pick a tool"
          options={[...names.map((name) => ({ value: name, label: name })), { value: OTHER, label: 'Other…' }]}
          onChange={onSelect}
        />
      )}
    </Field>
  );
}

/** The `toolCall` step's fields. */
export function ToolCallForm({ node, graph, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  return (
    <>
      <ToolField id={`${base}-tool`} step={step} graph={graph} patch={patch} />
      <JsonField
        id={`${base}-arguments`}
        label="Arguments"
        value={step.arguments}
        rows={6}
        check={(v) => (v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v)) ? undefined : 'Arguments must be a JSON object')}
        help="Strings can use {{variable}}."
        onChange={(next) => patch({ arguments: next })}
      />
      <OutputVariableField id={`${base}-output`} step={step} patch={patch} />
    </>
  );
}
