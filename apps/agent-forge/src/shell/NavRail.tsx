import { useRoute } from '../router/useRoute';
import { DaemonStatus } from './DaemonStatus';

export type NavSection = 'Build' | 'Observe' | 'Evaluate' | 'Assets' | 'Footer';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  section: NavSection;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agents', href: '#/agents', section: 'Build' },
  { id: 'playground', label: 'Playground', href: '#/playground', section: 'Build' },
  { id: 'traces', label: 'Traces', href: '#/traces', section: 'Observe' },
  { id: 'threads', label: 'Threads', href: '#/threads', section: 'Observe' },
  { id: 'monitoring', label: 'Monitoring', href: '#/monitoring', section: 'Observe' },
  { id: 'evals', label: 'Evaluations', href: '#/evals/scores', section: 'Evaluate' },
  { id: 'prompts', label: 'Prompts', href: '#/prompts', section: 'Assets' },
  { id: 'hub', label: 'Context Hub', href: '#/hub', section: 'Assets' },
  { id: 'settings', label: 'Settings', href: '#/settings', section: 'Footer' },
];

const SECTION_ORDER: NavSection[] = ['Build', 'Observe', 'Evaluate', 'Assets', 'Footer'];

const firstSegment = (path: string) => path.split('/')[1] ?? '';

/** An item owns every route under its first path segment (`/evals/datasets` -> Evaluations). The bare `/` is Agents. */
export function isActive(item: NavItem, path: string): boolean {
  const segment = firstSegment(path) || 'agents';
  return firstSegment(item.href.slice(1)) === segment;
}

export function NavRail({
  drawer,
  onNavigate,
}: {
  /** Narrow layout: the rail is a slide-over drawer in this state. Undefined when docked. */
  drawer?: 'open' | 'closed';
  onNavigate?: () => void;
}) {
  const { path } = useRoute();
  return (
    <nav id="primary-nav" className="nav-rail" aria-label="Primary" data-drawer={drawer}>
      <div className="nav-brand">Agent Forge</div>
      {SECTION_ORDER.map((section) => {
        const items = NAV_ITEMS.filter((i) => i.section === section);
        return (
          <ul key={section} className={`nav-group${section === 'Footer' ? ' nav-footer' : ''}`}>
            {section !== 'Footer' && (
              <li className="nav-heading" aria-hidden="true">
                {section}
              </li>
            )}
            {items.map((item) => {
              const active = isActive(item, path);
              return (
                <li key={item.id}>
                  <a
                    className={`nav-item${active ? ' active' : ''}`}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={onNavigate}
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        );
      })}
      <DaemonStatus />
    </nav>
  );
}
