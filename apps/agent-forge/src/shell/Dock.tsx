import './dock.css';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { writeStored } from '../components/storedValue';
import { NARROW_QUERY, useMediaQuery } from '../components/useMediaQuery';
import {
  DOCK_KEY_STEP,
  DOCK_MIN_WIDTH,
  DOCK_OPEN_KEY,
  DOCK_WIDTH_KEY,
  clampDockWidth,
  dockMaxWidth,
  readDockOpen,
  readDockWidth,
} from './dockState';

/** Open state and width of the shell's docked right panel, persisted to localStorage. */
export interface DockApi {
  open: boolean;
  /** Opens or closes the dock and remembers it (forge.dock.open). */
  setOpen(open: boolean): void;
  /** Flips `open`, persisting the result. */
  toggle(): void;
  /** Current clamped width, px. */
  width: number;
  /** Clamps `px` to [360, min(640, 45vw)] and remembers it (forge.dock.width). */
  setWidth(px: number): void;
}

interface DockState extends DockApi {
  /** Live width update while dragging the resize handle; the drag end calls `setWidth` to persist. */
  previewWidth(px: number): void;
}

const DockContext = createContext<DockState | null>(null);

function useDockState(): DockState {
  const state = useContext(DockContext);
  if (!state) throw new Error('useDock must be used inside a <DockProvider>.');
  return state;
}

/**
 * Holds the dock's open state and width for the shell and for whatever opens it
 * (AA19's Ctrl+J). Initial values come from localStorage; a viewport resize
 * re-clamps the width without rewriting it.
 */
export function DockProvider({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpenState] = useState(readDockOpen);
  const [width, setWidthState] = useState(() => readDockWidth(window.innerWidth));

  useEffect(() => {
    const onResize = () => setWidthState((w) => clampDockWidth(w, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writeStored(DOCK_OPEN_KEY, next ? '1' : '0');
  }, []);

  const toggle = useCallback(() => {
    setOpenState((was) => {
      writeStored(DOCK_OPEN_KEY, was ? '0' : '1');
      return !was;
    });
  }, []);

  const setWidth = useCallback((px: number) => {
    const clamped = clampDockWidth(px, window.innerWidth);
    setWidthState(clamped);
    writeStored(DOCK_WIDTH_KEY, String(clamped));
  }, []);

  const previewWidth = useCallback((px: number) => {
    setWidthState(clampDockWidth(px, window.innerWidth));
  }, []);

  const value = useMemo<DockState>(
    () => ({ open, setOpen, toggle, width, setWidth, previewWidth }),
    [open, setOpen, toggle, width, setWidth, previewWidth],
  );
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

/** The nearest DockProvider's API; throws 'useDock must be used inside a <DockProvider>.' outside one. */
export function useDock(): DockApi {
  return useDockState();
}

/** window.innerWidth kept current across resizes, for the separator's aria-valuemax. */
function useViewportWidth(): number {
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vw;
}

interface ResizeHandleProps {
  dragging: boolean;
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerCancel(e: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void;
}

/**
 * Pointer and keyboard behaviour of the dock's left-edge resize handle: drag with
 * pointer capture (live, unpersisted until release) or ArrowLeft/ArrowRight steps
 * and Home/End limits (each persisted). While dragging, `data-dock-resizing` on
 * `.app-shell` freezes the column transition.
 */
function useDockResize(handleRef: RefObject<HTMLDivElement>, dock: DockState): ResizeHandleProps {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; shell: Element | null } | null>(null);

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setDragging(false);
      const handle = handleRef.current;
      if (handle?.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      d.shell?.removeAttribute('data-dock-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dock.setWidth(d.startWidth + (d.startX - e.clientX));
    },
    [dock, handleRef],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = handleRef.current;
      const shell = e.currentTarget.closest('.app-shell');
      handle?.setPointerCapture?.(e.pointerId);
      drag.current = { startX: e.clientX, startWidth: dock.width, shell };
      setDragging(true);
      shell?.setAttribute('data-dock-resizing', '');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [dock, handleRef],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      dock.previewWidth(d.startWidth + (d.startX - e.clientX));
    },
    [dock],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      let next: number | undefined;
      if (e.key === 'ArrowLeft') next = dock.width + DOCK_KEY_STEP;
      else if (e.key === 'ArrowRight') next = dock.width - DOCK_KEY_STEP;
      else if (e.key === 'Home') next = DOCK_MIN_WIDTH;
      else if (e.key === 'End') next = dockMaxWidth(window.innerWidth);
      else return;
      e.preventDefault();
      dock.setWidth(next);
    },
    [dock],
  );

  return { dragging, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onKeyDown };
}

/** Remembers who had focus when the dock opens and hands it back on close (or document.body). */
function useOpenerFocus(open: boolean): void {
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (open) {
      if (openerRef.current === null) openerRef.current = document.activeElement;
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    else document.body.focus();
  }, [open]);
}

const SHEET_FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/** Sheet mode: move focus inside the dialog on open (the card's first focusable, else the aside). */
function useSheetFocus(open: boolean, narrow: boolean, asideRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open || !narrow) return;
    const aside = asideRef.current;
    if (!aside) return;
    const target = aside.querySelector<HTMLElement>(`.dock-card ${SHEET_FOCUSABLE}`);
    (target ?? aside).focus();
  }, [open, narrow, asideRef]);
}

interface DockResizeHandleViewProps extends ResizeHandleProps {
  handleRef: RefObject<HTMLDivElement>;
  width: number;
  max: number;
}

/** The dock's left-edge resize handle: a WAI-ARIA window splitter (role="separator"). */
function DockResizeHandle({ handleRef, width, max, dragging, ...handlers }: DockResizeHandleViewProps) {
  return (
    <div
      ref={handleRef}
      className="dock-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={DOCK_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging ? '' : undefined}
      {...handlers}
    />
  );
}

/**
 * The docked right panel itself; renders nothing while closed. Docked (> 860px)
 * it is a grid column that pushes the screen narrower, resizable from its left
 * edge; below 860px it is a right-side sheet over a scrim. `label` names the
 * <aside> landmark. Escape inside the panel closes it unless a child already
 * handled the key (preventDefault), and focus returns to whatever opened it.
 */
export function Dock({ label, children }: { label: string; children: ReactNode }): JSX.Element | null {
  const dock = useDockState();
  const narrow = useMediaQuery(NARROW_QUERY);
  const vw = useViewportWidth();
  const handleRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const { dragging, ...handleProps } = useDockResize(handleRef, dock);
  useOpenerFocus(dock.open);
  useSheetFocus(dock.open, narrow, asideRef);

  if (!dock.open) return null;

  const onAsideKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) dock.setOpen(false);
  };

  return (
    <>
      {narrow && <div className="dock-scrim" aria-hidden="true" onClick={() => dock.setOpen(false)} />}
      <aside
        id="app-dock"
        ref={asideRef}
        className={narrow ? 'dock dock-sheet' : 'dock'}
        aria-label={label}
        role={narrow ? 'dialog' : undefined}
        aria-modal={narrow ? true : undefined}
        tabIndex={narrow ? -1 : undefined}
        onKeyDown={onAsideKeyDown}
      >
        {!narrow && (
          <DockResizeHandle
            handleRef={handleRef}
            width={dock.width}
            max={dockMaxWidth(vw)}
            dragging={dragging}
            {...handleProps}
          />
        )}
        <div className="dock-card">{children}</div>
      </aside>
    </>
  );
}
