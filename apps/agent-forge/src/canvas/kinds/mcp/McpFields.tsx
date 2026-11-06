/**
 * The `mcp` kind's Inspector body: the record key, a Transport choice
 * between "Local command" (stdio) and "Remote URL" (http) that swaps the
 * item's shape while keeping the shared behaviour fields, one sub-form per
 * transport, the behaviour controls, and the probe section with per-tool
 * `Allowed` / `Ask first` toggles. Key edits go through `replace` (the key
 * sits outside `item`); everything else patches `data.item`.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { MCP_KEY_PATTERN } from '../../../graph/v2/kinds/mcp';
import type { Graph, McpNodeData, NodeOfKind } from '../../../graph/v2/types';
import { ChoiceField } from '../../fields/ChoiceField';
import type { KindFieldsProps } from '../index';
import { HttpForm } from './HttpForm';
import { McpBehaviour } from './McpBehaviour';
import { McpToolList } from './McpToolList';
import { StdioForm } from './StdioForm';
import { switchTransport, transportOf, type McpHttpItem, type McpStdioItem, type McpTransport } from './mcpItem';

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: 'stdio', label: 'Local command' },
  { value: 'http', label: 'Remote URL' },
];

/** The inline error for `data.key`, or `undefined`. */
function keyError(node: NodeOfKind<'mcp'>, graph: Graph): string | undefined {
  const key = node.data.key;
  if (key === '') return 'Required';
  if (!MCP_KEY_PATTERN.test(key)) return 'Use letters, digits, dash or underscore';
  const taken = graph.nodes.some(
    (n) =>
      n.id !== node.id &&
      n.kind === 'mcp' &&
      n.owner === node.owner &&
      n.proposed !== 'remove' &&
      (n.data as McpNodeData).key === key
  );
  return taken ? 'Another MCP server already uses this name' : undefined;
}

/** The mcp Inspector described above. */
export function McpFields({ node, graph, patch, replace }: KindFieldsProps<'mcp'>): JSX.Element {
  const { item } = node.data;
  const transport = transportOf(item);
  const onTransport = (next: McpTransport | undefined) => {
    if (next === undefined || next === transport) return;
    replace({ ...node.data, item: switchTransport(item, next) });
  };
  return (
    <>
      <Field
        id="node-mcp-key"
        label="Name"
        required
        error={keyError(node, graph)}
        hint="Tools appear as <name>__<tool>."
      >
        <Input
          value={node.data.key}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            replace({ ...node.data, key: event.target.value })
          }
        />
      </Field>
      <ChoiceField
        id="node-mcp-transport"
        label="Transport"
        value={transport}
        options={TRANSPORT_OPTIONS}
        onChange={onTransport}
      />
      {transport === 'stdio' ? (
        <StdioForm item={item as McpStdioItem} patch={patch} />
      ) : (
        <HttpForm item={item as McpHttpItem} patch={patch} />
      )}
      <McpBehaviour item={item} patch={patch} />
      <McpToolList node={node} graph={graph} patch={patch} />
    </>
  );
}
