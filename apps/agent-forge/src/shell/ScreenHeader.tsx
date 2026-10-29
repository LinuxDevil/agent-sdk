import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRoute } from '../router/useRoute';
import { useAppState } from '../state/AppState';
import { PageHeader, type PageHeaderProps } from '../ui/PageHeader';
import { StatusPill } from '../ui/StatusPill';
import { NAV_ITEMS, isActive } from './NavRail';

/** Props of {@link ScreenHeader}: PageHeader's, all optional. */
export type ScreenHeaderProps = Partial<PageHeaderProps>;

interface HeaderSlot {
  /** Where an overriding ScreenHeader portals its PageHeader. */
  target: HTMLElement | null;
  /** Called on mount by an overriding ScreenHeader; the returned function releases the claim. */
  claim: () => () => void;
}

const HeaderSlotContext = createContext<HeaderSlot | null>(null);

/**
 * The live run StatusPill (the page's one run-status region); its own component, so only it reads the app state.
 * `labelled` (beside a screen's own chips) makes its tooltip say whose status it is.
 */
function LiveRunStatus({ labelled }: { labelled: boolean }) {
  const { runStatus } = useAppState();
  const status = runStatus?.status ?? 'idle';
  return <StatusPill status={status} live title={labelled ? `Last builder run: ${status}` : undefined} />;
}

/**
 * The PageHeader with the shell's defaults: the active nav item's label, and the live run
 * status always, at the right end of the screen's own status chips. With chips, a hairline
 * divider sets the run pill apart; the two wrap as one (pageHeader.css hides the divider
 * when the chips render nothing).
 */
function DefaultedHeader({ title, status, ...rest }: ScreenHeaderProps) {
  const { path } = useRoute();
  const label = NAV_ITEMS.find((item) => isActive(item, path))?.label ?? 'Agent Forge';
  return (
    <PageHeader
      title={title ?? label}
      status={
        <>
          {status}
          <span className="page-header-run">
            {status != null && <span className="page-header-status-sep" aria-hidden="true" />}
            <LiveRunStatus labelled={status != null} />
          </span>
        </>
      }
      {...rest}
    />
  );
}

/**
 * The header at the top of a non-Agents screen. ScreenFrame renders a default one
 * (the nav label + live run status); a screen that renders its own
 * `<ScreenHeader title=… description=… actions={…} breadcrumbs={…} />` anywhere in
 * its tree replaces the default while mounted. `title` defaults to the active nav
 * item's label. The live run StatusPill is always in the title row; `status` adds the
 * screen's own chips (a prompt chip, label chips) before it and never replaces it.
 * The props render through a portal, so the screen's own context and state apply.
 */
export function ScreenHeader(props: ScreenHeaderProps) {
  const slot = useContext(HeaderSlotContext);
  const claim = slot?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  if (!slot) return <DefaultedHeader {...props} />;
  return slot.target ? createPortal(<DefaultedHeader {...props} />, slot.target) : null;
}

/**
 * Hosts the screen header for `children` (the screen): renders the default
 * ScreenHeader until a ScreenHeader inside `children` claims the slot.
 */
export function ScreenHeaderHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const slot = useMemo(() => ({ target, claim }), [target, claim]);
  return (
    <HeaderSlotContext.Provider value={slot}>
      <div className="screen-header">
        {claims === 0 && <DefaultedHeader />}
        <div ref={setTarget} className="screen-header-target" />
      </div>
      {children}
    </HeaderSlotContext.Provider>
  );
}
