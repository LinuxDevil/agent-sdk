/**
 * The `{ hosted }` form of the tool Inspector: the provider-hosted tool
 * picker and its options. When the main agent's model does not list the
 * picked tool in `capabilities.hostedTools`, the field carries a warning
 * hint — the run will still be tried, so it is a warning, not an error.
 */
import { useCatalog } from '../../useCatalog';
import type { AgentNodeData } from '../../../graph/v2/types';
import { ROOT_AGENT_ID, type Graph } from '../../../graph/v2/types';
import { ChoiceField } from '../../fields/ChoiceField';
import { JsonField } from '../../fields/JsonField';
import { checkJsonObject } from './toolForm';
import type { ToolSubFormProps } from './BuiltinForm';

type HostedName = 'web_search' | 'code_interpreter' | 'file_search';

const HOSTED_OPTIONS: { value: HostedName; label: string }[] = [
  { value: 'web_search', label: 'Web search' },
  { value: 'code_interpreter', label: 'Code interpreter' },
  { value: 'file_search', label: 'File search' },
];

/** The root agent's `fields.model`, or `undefined` when the root is missing/not an agent. */
function rootModel(graph: Graph): string | undefined {
  const root = graph.nodes.find((n) => n.id === ROOT_AGENT_ID && n.kind === 'agent');
  if (root === undefined || root.kind !== 'agent') return undefined;
  return (root.data as AgentNodeData).fields.model;
}

/** Props: the narrowed item, `patch`, and the graph (for the root model lookup). */
export interface HostedFormProps {
  item: ToolSubFormProps<'hosted'>['item'];
  patch: ToolSubFormProps<'hosted'>['patch'];
  graph: Graph;
}

/** The `{ hosted }` sub-form described above. */
export function HostedForm({ item, patch, graph }: HostedFormProps): JSX.Element {
  const models = useCatalog('models');
  const model = rootModel(graph);
  const entry = models.data?.find((m) => m.id === model);
  const hosted = item.hosted as string;
  const missing =
    entry !== undefined && hosted !== '' && !entry.capabilities.hostedTools.includes(hosted);
  return (
    <>
      <ChoiceField
        id="node-tool-hosted"
        label="Tool"
        required
        error={hosted === '' ? 'Pick a provider-hosted tool' : undefined}
        value={hosted === '' ? undefined : (hosted as HostedName)}
        options={HOSTED_OPTIONS}
        onChange={(next) => {
          if (next !== undefined) patch({ hosted: next });
        }}
        help={
          missing ? (
            <span className="field-warning">The selected model does not offer this tool</span>
          ) : undefined
        }
      />
      <JsonField
        id="node-tool-hosted-options"
        label="Options"
        rows={4}
        value={item.options}
        onChange={(options) => patch({ options })}
        check={checkJsonObject}
      />
    </>
  );
}
