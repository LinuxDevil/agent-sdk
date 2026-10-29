import './pageHeader.css';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** One breadcrumb above a page title; without `href` it renders as plain text. */
export interface PageHeaderCrumb {
  label: string;
  href?: string;
}

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
  /** The page's `<h1>`. A string title truncates with an ellipsis and keeps the full text as a tooltip. */
  title: ReactNode;
  /** One muted line under the title. */
  description?: ReactNode;
  /** Trail above the title; the last crumb is the current page (`aria-current="page"`). */
  breadcrumbs?: PageHeaderCrumb[];
  /** Inline right of the title, e.g. a StatusPill. */
  status?: ReactNode;
  /** Right side of the header (buttons); wraps under the title at narrow widths. */
  actions?: ReactNode;
  /**
   * A row of underline tabs under the title and actions (e.g. a section's sub-navigation),
   * inside the header: the active tab's underline sits on the header's bottom hairline.
   */
  tabs?: ReactNode;
  className?: string;
}

function Breadcrumbs({ crumbs }: { crumbs: PageHeaderCrumb[] }) {
  return (
    <nav className="page-header-crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${crumb.label}`}>
              {i > 0 && <ChevronRight className="page-header-crumb-sep" size={14} strokeWidth={1.75} aria-hidden="true" />}
              {crumb.href && !last ? (
                <a href={crumb.href}>{crumb.label}</a>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The header row at the top of a page: optional breadcrumbs, the page title (`<h1>`)
 * with an optional status beside it, an optional description, right-aligned
 * actions and an optional tabs row, over a bottom hairline. Purely presentational; in the Studio, screens
 * use the shell's `ScreenHeader`, which fills in the defaults and places it.
 */
export function PageHeader({ title, description, breadcrumbs, status, actions, tabs, className }: PageHeaderProps) {
  const classes = ['page-header', tabs != null && 'page-header-with-tabs', className].filter(Boolean).join(' ');
  return (
    <header className={classes}>
      <div className="page-header-main">
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs crumbs={breadcrumbs} />}
        <div className="page-header-title-row">
          <h1 className="page-header-title" title={typeof title === 'string' ? title : undefined}>
            {title}
          </h1>
          {status != null && <div className="page-header-status">{status}</div>}
        </div>
        {description != null && <p className="page-header-description">{description}</p>}
      </div>
      {actions != null && <div className="page-header-actions">{actions}</div>}
      {tabs != null && <div className="page-header-tabs">{tabs}</div>}
    </header>
  );
}
