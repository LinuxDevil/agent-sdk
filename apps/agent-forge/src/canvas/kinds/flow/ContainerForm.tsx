/**
 * `ContainerForm` — the `sequence`/`parallel` step's Inspector body: the
 * ordered child list with Up/Down reorder buttons (`moveChild` →
 * `reorderChild`). Parallel adds the "These run at the same time." hint.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Field } from '../../../ui/Field';
import type { KindFieldsProps } from '../index';
import { flowNodeTitle } from './flowForm';
import './flow.css';

type FlowProps = KindFieldsProps<'flow'>;

/** The ordered children of a `steps`-shaped flow node with reorder controls. */
export function ContainerForm({ node, graph, moveChild }: FlowProps): JSX.Element {
  const children = node.data.children;
  const ids = children.shape === 'steps' ? children.ids : [];
  const base = `node-flow-${String(node.data.step.id)}`;
  const parallel = String(node.data.step.type) === 'parallel';

  return (
    <Field
      id={`${base}-children`}
      label={parallel ? 'Steps (parallel)' : 'Steps'}
      hint={parallel ? 'These run at the same time.' : undefined}
    >
      <div className="kv-rows">
        {ids.map((childId, index) => {
          const title = flowNodeTitle(graph, childId);
          return (
            <div key={childId} className="kv-row flow-child-row">
              <span className="flow-child-title" title={title}>
                {title}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={`Move ${title} up`}
                disabled={index === 0 || moveChild === undefined}
                onClick={() => moveChild?.(childId, -1)}
              >
                <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={`Move ${title} down`}
                disabled={index === ids.length - 1 || moveChild === undefined}
                onClick={() => moveChild?.(childId, 1)}
              >
                <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {ids.length === 0 && <div className="hint">No steps inside yet — connect steps to this node on the canvas.</div>}
      </div>
    </Field>
  );
}
