import { useEffect, useState } from 'react';
import { LayoutTemplate, Plus, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { AGENT_TEMPLATES, graphFromTemplate, type TemplateId } from './templates';

/**
 * Each template card's kind icon: the kind its pipeline starts with, in that
 * kind's canvas tone (AgentNode.tsx's NODE_META, `kind-<tone>` in agents.css).
 */
const TEMPLATE_ICONS: Record<TemplateId, { Icon: LucideIcon; tone: 'violet' | 'accent' }> = {
  blank: { Icon: Sparkles, tone: 'violet' },
  'support-bot': { Icon: Zap, tone: 'accent' },
};

/** True between a drag's start and its end (or drop) anywhere in the window. */
function useDragInProgress(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = () => setDragging(true);
    const stop = () => setDragging(false);
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
  return dragging;
}

/**
 * Empty-canvas onboarding: while the open agent's graph has no nodes, the
 * canvas lists the starter templates. Choosing one replaces the graph through
 * `setGraph` (which marks the agent dirty, like any canvas edit) and keeps the
 * agent's own name; the open agent and its route do not change.
 *
 * While anything is being dragged (a palette node) the card steps aside, so
 * the drop lands on the React Flow pane rather than on the card.
 */
export function EmptyCanvas() {
  const { graph, spec, setGraph, setSelectedNodeId } = useAppState();
  const dragging = useDragInProgress();
  if (graph.nodes.length > 0 || dragging) return null;

  function choose(id: TemplateId) {
    const next = graphFromTemplate(id, spec.name || undefined);
    setGraph(() => next);
    setSelectedNodeId(next.nodes.find((n) => n.type === 'llm')?.id);
  }

  return (
    <div className="canvas-empty">
      <section className="canvas-empty-card" aria-labelledby="canvas-empty-title">
        <span className="canvas-empty-icon" aria-hidden="true">
          <LayoutTemplate size={20} strokeWidth={1.75} />
        </span>
        <h2 className="canvas-empty-title" id="canvas-empty-title">
          Start from a template
        </h2>
        <p className="canvas-empty-hint">
          This agent&apos;s canvas is empty. Pick a template, or drag a node in from the Nodes palette.
        </p>
        <button type="button" className="btn btn-primary canvas-empty-action" onClick={() => choose('blank')}>
          <Plus aria-hidden="true" />
          Start with a blank graph
        </button>
        <ul className="canvas-templates" aria-label="Templates">
          {AGENT_TEMPLATES.map((template) => {
            const { Icon, tone } = TEMPLATE_ICONS[template.id];
            return (
              <li key={template.id}>
                <button type="button" className="canvas-template" onClick={() => choose(template.id)}>
                  <span className={`node-kind kind-${tone}`} aria-hidden="true">
                    <Icon size={14} strokeWidth={1.75} />
                  </span>
                  <span className="canvas-template-text">
                    <span className="canvas-template-name">{template.name}</span>
                    <span className="canvas-template-desc">{template.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
