import './shell.css';
import { Menu } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NARROW_QUERY, useMediaQuery } from '../components/useMediaQuery';
import { useAppState } from '../state/AppState';
import { CommandPalette } from '../ui/CommandPalette';
import { LogoMark } from './NavBrand';
import { NavRail } from './NavRail';
import { useNavCollapsed } from './navCollapsed';

/** Lets the Studio side panels (rail/inspector drawers) yield when the nav drawer opens - one drawer at a time. */
const ShellContext = createContext({ navOpen: false });
export const useShell = () => useContext(ShellContext);

/** Says so when the live connection to the studio server drops, instead of going quietly stale. */
function ConnectionBanner() {
  const { connected } = useAppState();
  if (connected) return null;
  return (
    <div className="connection-banner" role="alert">
      Lost the connection to the studio server - reconnecting. Is <code>lousho studio</code> still running?
    </div>
  );
}

/**
 * Left navigation around every screen. Docked, it collapses to a 56px icon rail
 * (remembered in localStorage); below 860px it is a slide-over drawer (scrim / Escape close it).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [open, setOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useNavCollapsed();

  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const navOpen = narrow && open;
  return (
    <ShellContext.Provider value={{ navOpen }}>
      <div className={`app-shell${narrow ? ' app-shell-narrow' : ''}`} data-nav={!narrow && collapsed ? 'collapsed' : undefined}>
        {narrow && (
          <div className="app-shell-bar">
            <button
              type="button"
              className="btn btn-ghost nav-toggle"
              aria-label="Navigation"
              aria-expanded={navOpen}
              aria-controls="primary-nav"
              onClick={() => setOpen((o) => !o)}
            >
              <Menu size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <LogoMark />
            <span className="nav-bar-title">Agent Forge</span>
          </div>
        )}
        <NavRail
          drawer={narrow ? (navOpen ? 'open' : 'closed') : undefined}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onNavigate={() => setOpen(false)}
        />
        {navOpen && <div className="app-shell-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
        <div className="app-shell-main">
          <ConnectionBanner />
          {children}
        </div>
        <CommandPalette />
      </div>
    </ShellContext.Provider>
  );
}
