import { useState } from 'react';
import type { KindFieldsProps } from './index';
import type { GraphNode, NodeKind } from '../../graph/v2/types';

/**
 * Which slot of `node.data` the JSON draft edits: `item` for capability
 * nodes, `fields` for agent nodes, `step` for flow nodes, or the whole
 * `data` object (notes). Mirrors `patchNode`'s target rule.
 */
function editableSlot(data: GraphNode['data']): 'item' | 'fields' | 'step' | null {
  const record = data as unknown as Record<string, unknown>;
  if ('item' in record) return 'item';
  if ('fields' in record) return 'fields';
  if ('step' in record) return 'step';
  return null;
}

/** The value the JSON draft shows for `node`: `data.item ?? data.fields ?? data.step ?? data`. */
function draftOf(node: GraphNode): string {
  const slot = editableSlot(node.data);
  const record = node.data as unknown as Record<string, unknown>;
  return JSON.stringify(slot === null ? node.data : record[slot], null, 2);
}

/**
 * The generic Inspector body for a node kind with no registered `Fields`
 * form yet (`viewFor`'s fallback): one JSON textarea over the node's
 * editable spec slot. On blur a valid edit replaces the slot via
 * `replace`; an invalid one is kept in the draft with an alert so the
 * user can fix the JSON rather than lose it.
 */
export function GenericFields<K extends NodeKind>({ node, replace }: KindFieldsProps<K>) {
  const [draft, setDraft] = useState(() => draftOf(node));
  const [error, setError] = useState<string | undefined>(undefined);
  // A different selected node re-keys the draft through `useState`'s
  // per-render default only on mount - reset it explicitly on a node swap.
  const [draftNodeId, setDraftNodeId] = useState(node.id);
  if (draftNodeId !== node.id) {
    setDraftNodeId(node.id);
    setDraft(draftOf(node));
    setError(undefined);
  }

  function commit() {
    try {
      const parsed: unknown = JSON.parse(draft);
      const slot = editableSlot(node.data);
      const next =
        slot === null
          ? parsed
          : { ...(node.data as unknown as Record<string, unknown>), [slot]: parsed };
      replace(next as unknown as (typeof node)['data']);
      setError(undefined);
    } catch (e) {
      setError(`This is not valid JSON: ${(e as Error).message}`);
    }
  }

  return (
    <div className="field">
      <label htmlFor="node-json">Node data (JSON)</label>
      <textarea
        id="node-json"
        className="textarea mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        aria-invalid={error ? true : undefined}
        aria-describedby="node-json-error"
        spellCheck={false}
      />
      {error && (
        <div id="node-json-error" className="hint field-error" role="alert">
          {error}
        </div>
      )}
      <div className="hint">This node has no form yet. Edit its spec fields as JSON.</div>
    </div>
  );
}
