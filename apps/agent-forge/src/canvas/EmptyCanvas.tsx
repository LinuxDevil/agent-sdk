import { useAppState } from '../state/AppState';
import { EmptyState } from '../ui/EmptyState';
import { AGENT_TEMPLATES, graphFromTemplate, type TemplateId } from './templates';

/**
 * Empty-canvas onboarding: while the open agent's graph has no nodes, the
 * canvas lists the starter templates. Choosing one replaces the graph through
 * `setGraph` (which marks the agent dirty, like any canvas edit) and keeps the
 * agent's own name; the open agent and its route do not change.
 */
export function EmptyCanvas() {
  const { graph, spec, setGraph, setSelectedNodeId } = useAppState();
  if (graph.nodes.length > 0) return null;

  function choose(id: TemplateId) {
    const next = graphFromTemplate(id, spec.name || undefined);
    setGraph(() => next);
    setSelectedNodeId(next.nodes.find((n) => n.type === 'llm')?.id);
  }

  return (
    <div className="canvas-empty">
      <EmptyState
        title="Start from a template"
        hint="This agent's canvas is empty. Pick a template, or drag a node in from the Nodes palette."
        action={
          <ul className="canvas-templates" aria-label="Templates">
            {AGENT_TEMPLATES.map((template) => (
              <li key={template.id}>
                <button type="button" className="canvas-template" onClick={() => choose(template.id)}>
                  <span className="canvas-template-name">{template.name}</span>
                  <span className="canvas-template-desc">{template.description}</span>
                </button>
              </li>
            ))}
          </ul>
        }
      />
    </div>
  );
}
