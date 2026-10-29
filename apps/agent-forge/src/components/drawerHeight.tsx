import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { GripHorizontal } from 'lucide-react';
import { readStored, writeStored } from './storedValue';

/** localStorage key of the run drawer's height, in px. */
export const DRAWER_HEIGHT_KEY = 'forge.drawer.height';
/** The drawer's height before the viewer resizes it (the old fixed grid row). */
export const DRAWER_DEFAULT_HEIGHT = 240;
/** Shortest drawer: the tab bar plus a couple of log rows. */
export const DRAWER_MIN_HEIGHT = 120;
/** Tallest drawer, leaving the canvas room on a laptop screen. */
export const DRAWER_MAX_HEIGHT = 560;

const KEY_STEP = 16;

/** `height` rounded and kept within the drawer's min/max. */
function clampDrawerHeight(height: number): number {
  return Math.min(DRAWER_MAX_HEIGHT, Math.max(DRAWER_MIN_HEIGHT, Math.round(height)));
}

function storedHeight(): number {
  const stored = Number(readStored(DRAWER_HEIGHT_KEY) || NaN);
  return Number.isFinite(stored) ? clampDrawerHeight(stored) : DRAWER_DEFAULT_HEIGHT;
}

/** The run drawer's height, restored from and remembered in localStorage (`forge.drawer.height`). */
export function useDrawerHeight(): { height: number; setHeight: (height: number) => void } {
  const [height, setHeightState] = useState(storedHeight);
  const setHeight = useCallback((next: number) => {
    const clamped = clampDrawerHeight(next);
    setHeightState(clamped);
    writeStored(DRAWER_HEIGHT_KEY, String(clamped));
  }, []);
  return { height, setHeight };
}

const KEY_HEIGHTS: Record<string, (height: number) => number> = {
  ArrowUp: (h) => h + KEY_STEP,
  ArrowDown: (h) => h - KEY_STEP,
  Home: () => DRAWER_MIN_HEIGHT,
  End: () => DRAWER_MAX_HEIGHT,
};

/**
 * The drawer's top edge: drag it, or focus it and use the arrow keys
 * (Home/End for the min/max), to resize the drawer. A WAI-ARIA window
 * splitter (`role="separator"` with its current/min/max value).
 */
export function DrawerResizeHandle({ height, onResize }: { height: number; onResize: (height: number) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = KEY_HEIGHTS[e.key];
    if (!next) return;
    e.preventDefault();
    onResize(next(height));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const onMove = (move: globalThis.PointerEvent) => onResize(startHeight + (startY - move.clientY));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      className="drawer-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize run panels"
      aria-valuenow={height}
      aria-valuemin={DRAWER_MIN_HEIGHT}
      aria-valuemax={DRAWER_MAX_HEIGHT}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <GripHorizontal className="drawer-grip" size={16} strokeWidth={1.75} aria-hidden="true" />
    </div>
  );
}
