import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { NoteNodeData } from '../graph/v2/types';
import type { CanvasNodeData } from './NodeCard';

/**
 * The React Flow node for a `note` graph node (`agent-note` in
 * `AgentNode`'s `NODE_TYPES`): a sticky-note card, not a spec item, so it
 * draws no ports and no status chrome — just the text (pre-wrapped,
 * clamped to six lines by `.rf-note` in screens/agents/agents.css) or an
 * "Empty note" placeholder.
 */
function NoteNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodeData;
  const { graphNode } = nodeData;
  const text = (graphNode.data as NoteNodeData).text;
  const classes = ['rf-note', selected ? 'selected' : undefined].filter(Boolean).join(' ');
  return (
    <div className={classes} data-node-kind="note" data-node-id={graphNode.id}>
      {text === '' ? <span className="rf-note-empty">Empty note</span> : text}
    </div>
  );
}

const NoteNode = memo(NoteNodeImpl);

export { NoteNode };
