import { Activity, Bot, Boxes, ClipboardCheck, FileText, FlaskConical, Inbox, LayoutTemplate, Library, LineChart, MessagesSquare, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import { openAuthor } from '../author/authorEntry';
import { useInboxCount } from '../state/useInboxCount';
import { useRoute } from '../router/useRoute';
import { DaemonStatus } from './DaemonStatus';
import { NavBrand } from './NavBrand';

export type NavSection = 'Build' | 'Observe' | 'Evaluate' | 'Assets' | 'Footer';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  section: NavSection;
  /** The lucide icon drawn before the label (alone on the collapsed rail). */
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agents', href: '#/agents', section: 'Build', icon: Bot },
  { id: 'inbox', label: 'Inbox', href: '#/inbox', section: 'Build', icon: Inbox },
  { id: 'templates', label: 'Templates', href: '#/templates', section: 'Build', icon: LayoutTemplate },
  { id: 'playground', label: 'Playground', href: '#/playground', section: 'Build', icon: FlaskConical },
  { id: 'workspaces', label: 'Workspaces', href: '#/workspaces', section: 'Build', icon: Boxes },
  { id: 'traces', label: 'Traces', href: '#/traces', section: 'Observe', icon: Activity },
  { id: 'threads', label: 'Threads', href: '#/threads', section: 'Observe', icon: MessagesSquare },
  { id: 'monitoring', label: 'Monitoring', href: '#/monitoring', section: 'Observe', icon: LineChart },
  { id: 'evals', label: 'Evaluations', href: '#/evals/scores', section: 'Evaluate', icon: ClipboardCheck },
  { id: 'prompts', label: 'Prompts', href: '#/prompts', section: 'Assets', icon: FileText },
  { id: 'hub', label: 'Context Hub', href: '#/hub', section: 'Assets', icon: Library },
  { id: 'settings', label: 'Settings', href: '#/settings', section: 'Footer', icon: Settings },
];

const SECTION_ORDER: NavSection[] = ['Build', 'Observe', 'Evaluate', 'Assets', 'Footer'];

const firstSegment = (path: string) => path.split('/')[1] ?? '';

/** An item owns every route under its first path segment (`/evals/datasets` -> Evaluations). The bare `/` is Agents. `/w/<ws>/<section>/…` scopes a screen to a workspace (W04b): the section is the segment after the id. */
export function isActive(item: NavItem, path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const section = segments[0] === 'w' ? segments[2] : segments[0];
  const segment = section ?? 'agents';
  return firstSegment(item.href.slice(1)) === segment;
}

/** One nav link; on the collapsed rail it is icon-only, named by `aria-label` with a `title` tooltip. `badge` is the waiting count (Inbox only). */
function NavLink({ item, active, collapsed, badge = 0, onNavigate }: { item: NavItem; active: boolean; collapsed: boolean; badge?: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  const badgeText = badge > 99 ? '99+' : String(badge);
  return (
    <a
      className={`nav-item${active ? ' active' : ''}`}
      href={item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? (badge > 0 ? `${item.label} (${badge} waiting)` : item.label) : undefined}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
    >
      <Icon className="nav-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{item.label}</span>
      {badge > 0 &&
        (collapsed ? (
          <span className="nav-badge-dot" aria-hidden="true" />
        ) : (
          <span className="nav-badge" aria-label={`${badge} waiting`}>
            {badgeText}
          </span>
        ))}
    </a>
  );
}

export function NavRail({
  drawer,
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: {
  /** Narrow layout: the rail is a slide-over drawer in this state. Undefined when docked. */
  drawer?: 'open' | 'closed';
  /** Docked only: the 56px icon rail. Ignored in the drawer. */
  collapsed?: boolean;
  /** Docked only: shows the collapse toggle in the nav header. */
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  const { path } = useRoute();
  const inboxCount = useInboxCount();
  const rail = drawer === undefined && collapsed;
  return (
    <nav id="primary-nav" className="nav-rail" aria-label="Primary" data-drawer={drawer} data-collapsed={rail || undefined}>
      <NavBrand collapsed={rail} onToggle={drawer === undefined ? onToggleCollapsed : undefined} />
      {SECTION_ORDER.map((section) => (
        <ul key={section} className={`nav-group${section === 'Footer' ? ' nav-footer' : ''}`}>
          {section !== 'Footer' && (
            <li className={rail ? 'nav-divider' : 'nav-heading overline'} aria-hidden="true">
              {rail ? null : section}
            </li>
          )}
          {NAV_ITEMS.filter((i) => i.section === section).map((item) => (
            <li key={item.id}>
              <NavLink item={item} active={isActive(item, path)} collapsed={rail} badge={item.id === 'inbox' ? inboxCount : 0} onNavigate={onNavigate} />
            </li>
          ))}
          {section === 'Footer' && (
            <li>
              <button
                type="button"
                className="icon-btn author-trigger"
                aria-label="Agent Author (Ctrl+J)"
                title="Agent Author (Ctrl+J)"
                onClick={() => {
                  openAuthor({ source: 'header' });
                  onNavigate?.(); // the narrow drawer yields to the dock sheet
                }}
              >
                <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="nav-label">Agent Author</span>
              </button>
            </li>
          )}
        </ul>
      ))}
      <DaemonStatus />
    </nav>
  );
}
