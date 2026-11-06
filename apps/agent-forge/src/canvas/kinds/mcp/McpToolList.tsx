/**
 * The MCP Inspector's probe section: the Probe button (disabled while the
 * command/URL is invalid), the probing and error states, and — after a
 * successful probe — one row per advertised tool with an `Allowed`
 * checkbox (writes `item.tools.exclude`) and an `Ask first` checkbox
 * (adds/removes a `{ action: 'ask' }` permission node for
 * `'<server key>__<tool>'`).
 */
import { Plug } from 'lucide-react';
import { useAppState } from '../../../state/AppState';
import { Checkbox } from '../../../ui/controls';
import { addNode, removeNode } from '../../../graph/v2/mutations';
import { nextItemId } from '../../../graph/v2/nodeIds';
import type { GraphNode } from '../../../graph/v2/types';
import type { McpProbeTool } from '../../../../shared/wireTypes';
import type { KindFieldsProps } from '../index';
import { askFirstNode, isAllowed, permissionIds, probeable, toggleAllowed } from './mcpItem';
import { useMcpProbe } from './useMcpProbe';
import './mcp.css';

/** Props for {@link McpToolList}: the node (for owner/key/position), the graph and `patch`. */
export interface McpToolListProps {
  node: KindFieldsProps<'mcp'>['node'];
  graph: KindFieldsProps<'mcp'>['graph'];
  patch: KindFieldsProps<'mcp'>['patch'];
}

/** Where an `Ask first` permission node lands: just below the server node, in the same coordinate space. */
const PERM_OFFSET = { x: 0, y: 160 };

/** One tool row: mono name, clamped description, the two checkboxes. */
function ToolRow({
  tool,
  allowed,
  askFirst,
  onAllowed,
  onAskFirst,
}: {
  tool: McpProbeTool;
  allowed: boolean;
  askFirst: boolean;
  onAllowed(on: boolean): void;
  onAskFirst(on: boolean): void;
}): JSX.Element {
  return (
    <div className="mcp-tool">
      <div className="mcp-tool-text">
        <span className="mcp-tool-name">{tool.name}</span>
        <span className="mcp-tool-desc">{tool.description}</span>
      </div>
      <Checkbox
        label="Allowed"
        aria-label={`Allow ${tool.name}`}
        checked={allowed}
        onChange={(event) => onAllowed(event.target.checked)}
      />
      <Checkbox
        label="Ask first"
        aria-label={`Ask first for ${tool.name}`}
        checked={askFirst}
        onChange={(event) => onAskFirst(event.target.checked)}
      />
    </div>
  );
}

/** The probe section described above. */
export function McpToolList({ node, graph, patch }: McpToolListProps): JSX.Element {
  const { setGraph } = useAppState();
  const { item } = node.data;
  const probe = useMcpProbe(item);
  const valid = probeable(item);

  /** Adds/removes the `{ action: 'ask' }` permission node for `'<key>__<name>'`, owned by this node's owner. */
  const onAskFirst = (name: string, on: boolean): void => {
    const toolName = `${node.data.key}__${name}`;
    setGraph((g) => {
      const existing = askFirstNode(g, node.owner, toolName);
      if (!on) return existing === undefined ? g : removeNode(g, existing.id);
      if (existing !== undefined) return g;
      const data: GraphNode['data'] = {
        item: { id: nextItemId('p', permissionIds(g)), tool: toolName, action: 'ask' },
      };
      const position = {
        x: node.position.x + PERM_OFFSET.x,
        y: node.position.y + PERM_OFFSET.y,
      };
      return addNode(g, { kind: 'permission', data }, position, node.owner).graph;
    });
  };

  return (
    <>
      <div className="field">
        <button
          type="button"
          id="node-mcp-probe"
          className="btn btn-secondary btn-sm"
          disabled={!valid || probe.state === 'probing'}
          title={valid ? undefined : 'Fix the errors above first'}
          onClick={probe.probe}
        >
          <Plug size={16} strokeWidth={1.75} aria-hidden="true" />
          Probe
        </button>
      </div>
      {probe.state === 'probing' && <p className="hint">Asking the server for its tools…</p>}
      {probe.state === 'error' && (
        <p className="hint field-error" role="alert">
          Could not reach the server: {probe.error}
        </p>
      )}
      {probe.state === 'done' && (
        <div className="field">
          <span className="field-label">Tools</span>
          <div className="mcp-tools" id="node-mcp-tools">
            {probe.tools.map((tool) => {
              const toolName = `${node.data.key}__${tool.name}`;
              return (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  allowed={isAllowed(item, tool.name)}
                  askFirst={askFirstNode(graph, node.owner, toolName) !== undefined}
                  onAllowed={(on) => patch({ tools: toggleAllowed(item.tools, tool.name, on) })}
                  onAskFirst={(on) => onAskFirst(tool.name, on)}
                />
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

