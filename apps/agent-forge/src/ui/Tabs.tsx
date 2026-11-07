import './tabs.css';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Which edges of a horizontally scrolled strip have hidden content. */
type Overflow = 'none' | 'start' | 'end' | 'both';

/** One entry of a {@link Tabs} strip: a hash-route link, or a disabled placeholder when `disabled`. */
export interface TabItem {
  /** Stable id matched against `TabsProps.currentId`; also stamped as `data-tab-id`. */
  id: string;
  /** The tab's text. */
  label: string;
  /** Hash route the tab navigates to, e.g. `#/agents/support-bot/runs`. */
  href: string;
  /** 14px icon drawn before the label. */
  icon?: LucideIcon;
  /** Drawn as a pill after the label when defined. */
  count?: number;
  /** Rendered as a non-link placeholder instead of a link. */
  disabled?: boolean;
  /** Why the tab is disabled, shown as a tooltip — required when `disabled`. */
  disabledReason?: string;
}

/** Props of {@link Tabs}. */
export interface TabsProps {
  /** `aria-label` of the `<nav>` wrapping the strip. */
  label: string;
  items: TabItem[];
  /** Id of the tab owning the current route; `undefined` when none does. */
  currentId: string | undefined;
  /** Pinned right of the strip (e.g. readiness chips); wraps under it at narrow widths. */
  trailing?: ReactNode;
  className?: string;
}

/** Which edges of a horizontally scrolled strip have hidden content (1px tolerance). */
export function overflowEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): Overflow {
  const start = scrollLeft > 1;
  const end = scrollLeft + clientWidth < scrollWidth - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
}

/** The icon, label and count pill shared by link and disabled tabs. */
function TabContent({ item }: { item: TabItem }) {
  const Icon = item.icon;
  return (
    <>
      {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" />}
      <span className="tabs-label">{item.label}</span>
      {item.count != null && (
        <span className="tabs-count tabular-nums">
          <span className="visually-hidden">, </span>
          {item.count}
        </span>
      )}
    </>
  );
}

/**
 * A row of underline tabs that are hash-route links (the navigation-links pattern,
 * not `role="tablist"`): the tab owning the current route gets `aria-current="page"`
 * and a 2px accent underline that lands on the PageHeader hairline. The strip scrolls
 * horizontally with no scrollbar, fades hidden edges, and scrolls the current tab
 * into view with a 12px gutter. `trailing` pins content at the right of the strip.
 */
export function Tabs({ label, items, currentId, trailing, className }: TabsProps): JSX.Element {
  const stripRef = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState<Overflow>('none');

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const current = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && (current.offsetLeft < strip.scrollLeft || current.offsetLeft + current.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = current.offsetLeft - 12;
    }
    const update = () => setOverflow(overflowEdges(strip.scrollLeft, strip.clientWidth, strip.scrollWidth));
    update();
    strip.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      strip.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [currentId]);

  return (
    <div className={['tabs', className].filter(Boolean).join(' ')}>
      <nav className="tabs-strip" aria-label={label} data-overflow={overflow} ref={stripRef}>
        {items.map((item) =>
          item.disabled ? (
            <span
              key={item.id}
              className="tabs-tab tabs-tab-disabled"
              aria-disabled="true"
              title={item.disabledReason}
              data-tab-id={item.id}
            >
              <TabContent item={item} />
            </span>
          ) : (
            <a
              key={item.id}
              className="tabs-tab"
              href={item.href}
              aria-current={item.id === currentId ? 'page' : undefined}
              data-tab-id={item.id}
            >
              <TabContent item={item} />
            </a>
          ),
        )}
      </nav>
      {trailing != null && <div className="tabs-trailing">{trailing}</div>}
    </div>
  );
}
