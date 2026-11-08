/**
 * One template card in the Templates grid (A10): the tile, the title (the
 * card's one button - its ::after stretches over the whole card), the
 * category, a clamped description, up to three tags and the "Needs …" line.
 */
import { LayoutTemplate } from 'lucide-react';
import type { TemplateSummary } from '../../../shared/wireTypes';
import '../../ui/tileCard.css';
import { requiresLine } from './templatesModel';

/** At most this many tags show on a card. */
const MAX_TAGS = 3;

export function TemplateCard({ summary, onOpen }: { summary: TemplateSummary; onOpen(id: string): void }) {
  const titleId = `template-card-title-${summary.id}`;
  const needs = requiresLine(summary.requires);
  return (
    <article className="template-card tile-card agent-tile-host" aria-labelledby={titleId}>
      <span className="template-card-tile">
        <LayoutTemplate size={18} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <h3 className="template-card-title" id={titleId}>
        <button type="button" className="template-card-open" onClick={() => onOpen(summary.id)}>
          {summary.title}
        </button>
      </h3>
      <p className="template-card-category">{summary.category}</p>
      <p className="template-card-description">{summary.description}</p>
      {summary.tags.length > 0 && (
        <ul className="template-card-tags">
          {summary.tags.slice(0, MAX_TAGS).map((tag) => (
            <li key={tag} className="template-card-tag">
              {tag}
            </li>
          ))}
        </ul>
      )}
      {needs !== '' && <p className="template-card-requires">{needs}</p>}
    </article>
  );
}
