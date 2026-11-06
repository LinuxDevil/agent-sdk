/**
 * The `tool` kind's Inspector body: the Type select swaps the `ToolRef`
 * variant (the new form starts empty but keeps `id`, and `approval`/
 * `deferLoading` when the form carries them), one sub-form edits the
 * variant's own fields, and the Behaviour section holds the common
 * controls (approval, on-demand loading, node id).
 */
import { ChoiceField } from '../../fields/ChoiceField';
import type { KindFieldsProps } from '../index';
import { BehaviourFields } from './BehaviourFields';
import { BuiltinForm } from './BuiltinForm';
import { FileForm } from './FileForm';
import { HostedForm } from './HostedForm';
import { IntegrationForm } from './IntegrationForm';
import { OpenApiForm } from './OpenApiForm';
import { RegistryForm } from './RegistryForm';
import { emptyToolItem, toolFormOf, type ToolForm } from './toolForm';

const FORM_OPTIONS: { value: ToolForm; label: string }[] = [
  { value: 'builtin', label: 'Built-in' },
  { value: 'registry', label: 'Registry' },
  { value: 'file', label: 'File' },
  { value: 'integration', label: 'Integration' },
  { value: 'openapi', label: 'OpenAPI' },
  { value: 'hosted', label: 'Provider-hosted' },
  { value: 'hub', label: 'Context Hub' },
];

/** The tool Inspector described above. */
export function ToolFields({ node, graph, patch, replace }: KindFieldsProps<'tool'>): JSX.Element {
  const { item } = node.data;
  const form = toolFormOf(item);
  const onForm = (next: ToolForm | undefined) => {
    if (next === undefined || next === form) return;
    replace({ item: emptyToolItem(next, item) });
  };
  return (
    <>
      <ChoiceField id="node-tool-form" label="Type" value={form} options={FORM_OPTIONS} onChange={onForm} />
      {form === 'builtin' && 'builtin' in item && <BuiltinForm item={item} patch={patch} />}
      {form === 'registry' && 'registry' in item && <RegistryForm item={item} patch={patch} />}
      {form === 'file' && 'file' in item && <FileForm item={item} patch={patch} />}
      {form === 'integration' && 'integration' in item && <IntegrationForm item={item} patch={patch} />}
      {form === 'openapi' && 'openapi' in item && <OpenApiForm item={item} patch={patch} />}
      {form === 'hosted' && 'hosted' in item && <HostedForm item={item} patch={patch} graph={graph} />}
      {form === 'hub' && (
        <div className="field">
          <p className="hint">Adds hub_publish and hub_query. Needs the observe daemon running.</p>
        </div>
      )}
      <BehaviourFields item={item} patch={patch} />
    </>
  );
}
