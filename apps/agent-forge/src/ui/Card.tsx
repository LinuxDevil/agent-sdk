import { useId, type ReactNode } from 'react';
import './card.css';

/** Props for {@link Card}. */
interface CardProps {
  /** Header title (an h2). With `as='section'` it also labels the card. */
  title?: ReactNode;
  /** Muted line under the title. */
  description?: ReactNode;
  /** Right side of the header row (buttons, a range picker). */
  actions?: ReactNode;
  /** `'md'` (default) pads the body; `'none'` lets a DataTable run edge to edge. */
  padding?: 'md' | 'none';
  className?: string;
  /** `'section'` (default) is a region labelled by its title; `'div'` a plain box. */
  as?: 'section' | 'div';
  children?: ReactNode;
}

/**
 * The Studio's panel: surface, hairline border, large radius, a soft lift,
 * and an optional header row (title + description left, actions right).
 */
export function Card({ title, description, actions, padding = 'md', className, as: Tag = 'section', children }: CardProps) {
  const titleId = useId();
  const labelled = Tag === 'section' && title != null;
  const classes = ['card', `card-pad-${padding}`, className].filter(Boolean).join(' ');
  return (
    <Tag className={classes} aria-labelledby={labelled ? titleId : undefined}>
      {title != null && (
        <div className="card-header">
          <div className="card-heading">
            <h2 className="card-title" id={titleId}>
              {title}
            </h2>
            {description != null && <p className="card-description">{description}</p>}
          </div>
          {actions != null && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </Tag>
  );
}
