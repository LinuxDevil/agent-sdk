import type { ReactNode } from 'react';
import { Link2, type LucideIcon } from 'lucide-react';

import { useToast } from './Toast';
import './card.css';
import './headerCard.css';

/** One metric chip: the icon stands for the label (read out, and shown as the chip's tooltip), then the value. */
export function Fact({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="header-card-fact" title={label}>
      <dt>
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="visually-hidden">{label}</span>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A muted unit after a fact's value (`1,204 tokens`). */
export const FactUnit = ({ children }: { children: ReactNode }) => <span className="header-card-fact-unit"> {children}</span>;

/** An icon button that copies the current URL (query included) and toasts the outcome. */
export function CopyLinkButton() {
  const toast = useToast();
  const copy = () => {
    const href = window.location.href;
    const write = navigator.clipboard?.writeText(href) ?? Promise.reject(new Error('Clipboard unavailable'));
    write.then(
      () => toast.show({ message: 'Link copied', tone: 'success' }),
      () => toast.show({ message: 'Could not copy the link', tone: 'error' }),
    );
  };
  return (
    <button type="button" className="btn btn-ghost btn-icon header-card-copy" aria-label="Copy link" title="Copy link" onClick={copy}>
      <Link2 aria-hidden="true" />
    </button>
  );
}

/** Props for {@link HeaderCard}. */
interface HeaderCardProps {
  /** The h2: one line, ellipsed, its full text in the tooltip. */
  title: string;
  /** Beside the title (a StatusPill). */
  status?: ReactNode;
  /** Right side of the title row. */
  actions?: ReactNode;
  /** The `<Fact>` chips. */
  facts: ReactNode;
  className?: string;
}

/**
 * A detail screen's header card (the trace and thread screens): the kit's
 * card with a title row (name, status, actions) over a row of metric chips.
 */
export function HeaderCard({ title, status, actions, facts, className }: HeaderCardProps) {
  return (
    <header className={className ? `card header-card ${className}` : 'card header-card'}>
      <div className="header-card-title">
        <div className="header-card-name">
          <h2 title={title}>{title}</h2>
          {status}
        </div>
        {actions && <div className="header-card-actions">{actions}</div>}
      </div>
      <dl className="header-card-facts">{facts}</dl>
    </header>
  );
}
