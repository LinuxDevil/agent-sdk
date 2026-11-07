/**
 * The `permission` kind's Inspector body: the tool list (a
 * `StringListField` with the owner's tool names and `<mcpKey>__*` globs
 * as suggestions), the action, the reason, the ask/auto `ttlMs` and the
 * `when` matcher editor, then the rule id. Everything patches `data.item`
 * — the fields sit flat on the `PermissionRuleSpec`, so no `replace` is
 * needed.
 *
 * `tool` keeps the spec's string/array shape: one entry writes a string,
 * several write an array and none write `[]` (the validator flags it with
 * 'Add at least one tool name or pattern').
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { allPermissionIds, PERMISSION_ID_PATTERN } from '../../../graph/v2/kinds/permission';
import { toolNodeName } from '../../../graph/v2/nodeIds';
import type { PermissionRuleSpec } from '../../../graph/v2/specTypes';
import type { Graph, McpNodeData, NodeOfKind, ToolNodeData } from '../../../graph/v2/types';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import { StringListField } from '../../fields/StringListField';
import { WhenMatcherEditor } from './WhenMatcherEditor';
import type { KindFieldsProps } from '../index';

type Action = PermissionRuleSpec['action'];

const ACTION_OPTIONS: { value: Action; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
  { value: 'ask', label: 'Ask a person' },
  { value: 'auto', label: 'Let a model decide' },
];

/** The Action help shown only on 'Let a model decide'. */
const AUTO_HELP =
  'A model approves safe-looking calls and asks a person otherwise. It never denies.';

/** The datalist suggestions for the Tools field: the owner's tool node names plus each MCP server's `__*` glob. */
function toolSuggestions(graph: Graph, owner: string | null): string[] {
  const names: string[] = [];
  for (const node of graph.nodes) {
    if (node.owner !== owner || node.proposed === 'remove') continue;
    if (node.kind === 'tool') names.push(toolNodeName((node.data as ToolNodeData).item));
    else if (node.kind === 'mcp') names.push(`${(node.data as McpNodeData).key}__*`);
  }
  return names;
}

/** The id field's error: empty, outside the spec pattern, or used by another rule. */
function idError(node: NodeOfKind<'permission'>, graph: Graph): string | undefined {
  const id = node.data.item.id;
  if (id === '') return 'The rule needs an id';
  if (!PERMISSION_ID_PATTERN.test(id)) {
    return 'The id can use letters, digits, dot, dash or underscore';
  }
  return allPermissionIds(graph).filter((other) => other === id).length > 1
    ? 'Another rule uses this id'
    : undefined;
}

/** `item.tool` as a chip list (an array stays an array, a string becomes one chip). */
function toolList(tool: PermissionRuleSpec['tool']): string[] {
  return [tool].flat().filter((pattern): pattern is string => typeof pattern === 'string');
}

/** The chip list as `item.tool`: one entry is a string, several an array, none `[]` (the validator flags it). */
function toolValue(list: string[] | undefined): string | string[] {
  if (list === undefined || list.length === 0) return [];
  return list.length === 1 ? list[0] : list;
}

/** The permission Inspector described above. */
export function PermissionFields({ node, graph, patch }: KindFieldsProps<'permission'>): JSX.Element {
  const { item } = node.data;
  const tools = toolList(item.tool);
  return (
    <>
      <StringListField
        id="node-perm-tools"
        label="Tools"
        value={tools}
        onChange={(list) => patch({ tool: toolValue(list) })}
        placeholder="Add a tool name or pattern"
        suggestions={toolSuggestions(graph, node.owner)}
        error={tools.length === 0 ? 'Add a tool name or pattern' : undefined}
        help="Use * as a wildcard, e.g. github__*."
      />
      <ChoiceField
        id="node-perm-action"
        label="Action"
        value={item.action}
        options={ACTION_OPTIONS}
        onChange={(action) => patch({ action })}
        help={item.action === 'auto' ? AUTO_HELP : undefined}
      />
      <Field
        id="node-perm-reason"
        label="Reason"
        hint="Shown to the model and in the approval card."
      >
        <Input
          value={item.reason ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ reason: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      {(item.action === 'ask' || item.action === 'auto') && (
        <OptionalNumberField
          id="node-perm-ttl"
          label="Remember approval for"
          value={item.ttlMs}
          onChange={(ttlMs) => patch({ ttlMs })}
          integer
          min={1000}
          unit="ms"
        />
      )}
      <WhenMatcherEditor
        id="node-perm-when"
        label="Conditions"
        value={item.when}
        onChange={(when) => patch({ when })}
        help="Every condition must hold for the rule to apply."
      />
      <Field id="node-perm-id" label="Id" required error={idError(node, graph)}>
        <Input
          value={item.id}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ id: event.target.value })}
        />
      </Field>
    </>
  );
}
