import { Anvil, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

/** The Agent Forge logo mark: a small accent square with an anvil. Decorative; the wordmark or a label names it. */
export function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <Anvil size={16} strokeWidth={1.75} />
    </span>
  );
}

/**
 * The nav header: logo mark, "Agent Forge" wordmark and the SDK version tag, plus the
 * collapse toggle when docked (`onToggle` given). Collapsed, only the mark and the toggle show.
 */
export function NavBrand({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="nav-brand">
      <LogoMark />
      {!collapsed && (
        <span className="nav-wordmark">
          Agent Forge{' '}
          <span className="nav-version">v{__LOUSHO_VERSION__}</span>
        </span>
      )}
      {onToggle && (
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm nav-collapse"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          aria-controls="primary-nav"
          onClick={onToggle}
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
