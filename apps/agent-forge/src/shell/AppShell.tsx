import './shell.css';
import { Menu } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { registerAuthorDock, toggleAuthor } from '../author/authorEntry';
import { NARROW_QUERY, useMediaQuery } from '../components/useMediaQuery';
import { useAppState } from '../state/AppState';
import { CommandPalette } from '../ui/CommandPalette';
import { Dock, DockProvider, useDock, type DockApi } from './Dock';
import { LogoMark } from './NavBrand';
import { NavRail } from './NavRail';
import { useNavCollapsed } from './navCollapsed';
import { matchShortcut } from './shortcuts';

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
 * The narrow-mode nav drawer: open state, Escape close, and exclusivity with
 * the dock sheet (opening the drawer closes the dock).
 */
function useNavDrawer(narrow: boolean, dock: DockApi): { navOpen: boolean; toggleNav: () => void; closeNav: () => void } {
  const [open, setOpen] = useState(false);

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
  useEffect(() => {
    if (navOpen) dock.setOpen(false);
  }, [navOpen, dock]);

  const toggleNav = useCallback(() => setOpen((o) => !o), []);
  const closeNav = useCallback(() => setOpen(false), []);
  return { navOpen, toggleNav, closeNav };
}

/** The narrow-mode top bar: hamburger button, logo and app name. Only rendered below 860px. */
function NarrowBar({ navOpen, onToggle }: { navOpen: boolean; onToggle: () => void }) {
  return (
    <div className="app-shell-bar">
      <button
        type="button"
        className="btn btn-ghost nav-toggle"
        aria-label="Navigation"
        aria-expanded={navOpen}
        aria-controls="primary-nav"
        onClick={onToggle}
      >
        <Menu size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <LogoMark />
      <span className="nav-bar-title">Agent Forge</span>
    </div>
  );
}

/**
 * Left navigation around every screen. Docked, it collapses to a 56px icon rail
 * (remembered in localStorage); below 860px it is a slide-over drawer (scrim / Escape close it).
 * `dock` is the optional right-hand panel column (the Agent Author's content);
 * when it is undefined the dock never renders, even if an open state is stored.
 */
export function AppShell({ children, dock }: { children: ReactNode; dock?: ReactNode }) {
  return (
    <DockProvider>
      <ShellLayout dock={dock}>{children}</ShellLayout>
    </DockProvider>
  );
}

/** Attributes of the `.app-shell` grid: rail 232/56px, flexible screen, optional dock column. */
function gridAttrs(narrow: boolean, collapsed: boolean, docked: boolean, dockWidth: number) {
  return {
    className: `app-shell${narrow ? ' app-shell-narrow' : ''}`,
    'data-nav': !narrow && collapsed ? ('collapsed' as const) : undefined,
    'data-dock': docked ? ('open' as const) : undefined,
    style: docked ? ({ '--dock-width': `${dockWidth}px` } as CSSProperties) : undefined,
  };
}

/**
 * The shell's global Author keys (AA19): Ctrl/Cmd+J toggles the dock through
 * `authorEntry` (bubble phase, so the command palette's modal dialog can keep
 * the key to itself; `preventDefault` only on a match, beating the browser's
 * Downloads shortcut). The dock API is registered with `authorEntry` so
 * `openAuthor`/`toggleAuthor` can drive it from outside the React tree.
 */
function useAuthorShortcuts(dock: DockApi): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || matchShortcut(e) !== 'author') return;
      e.preventDefault();
      toggleAuthor();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    registerAuthorDock({ isOpen: () => dock.open, setOpen: dock.setOpen });
    return () => registerAuthorDock(null);
  }, [dock.open, dock.setOpen]);
}

/** The shell markup; lives inside DockProvider so the dock API can drive its grid. */
function ShellLayout({ children, dock }: { children: ReactNode; dock?: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [collapsed, toggleCollapsed] = useNavCollapsed();
  const dockApi = useDock();
  const { navOpen, toggleNav, closeNav } = useNavDrawer(narrow, dockApi);
  const docked = dock !== undefined && dockApi.open && !narrow;
  useAuthorShortcuts(dockApi);

  return (
    <ShellContext.Provider value={{ navOpen }}>
      <div {...gridAttrs(narrow, collapsed, docked, dockApi.width)}>
        {narrow && <NarrowBar navOpen={navOpen} onToggle={toggleNav} />}
        <NavRail
          drawer={narrow ? (navOpen ? 'open' : 'closed') : undefined}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onNavigate={closeNav}
        />
        {navOpen && <div className="app-shell-scrim" aria-hidden="true" onClick={closeNav} />}
        <div className="app-shell-main">
          <ConnectionBanner />
          {children}
        </div>
        {dock !== undefined && <Dock label="Agent Author">{dock}</Dock>}
        <CommandPalette />
      </div>
    </ShellContext.Provider>
  );
}
