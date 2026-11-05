import { readStored } from '../components/storedValue';

/** Width limits of the docked panel, px. The max is also capped at 45% of the viewport. */
export const DOCK_MIN_WIDTH = 360;
export const DOCK_MAX_WIDTH = 640;
export const DOCK_DEFAULT_WIDTH = 490;
export const DOCK_MAX_VIEWPORT_FRACTION = 0.45;
/** Keyboard resize step, px. */
export const DOCK_KEY_STEP = 16;
/** localStorage keys: width as an integer string; open as "1" | "0". */
export const DOCK_WIDTH_KEY = 'forge.dock.width';
export const DOCK_OPEN_KEY = 'forge.dock.open';

/** The largest allowed width for this viewport: min(640, floor(45% of vw)), never below 360. */
export function dockMaxWidth(viewportWidth: number): number {
  return Math.max(
    DOCK_MIN_WIDTH,
    Math.min(DOCK_MAX_WIDTH, Math.floor(viewportWidth * DOCK_MAX_VIEWPORT_FRACTION)),
  );
}

/** `px` rounded and clamped to [DOCK_MIN_WIDTH, dockMaxWidth(viewportWidth)]; NaN → DOCK_DEFAULT_WIDTH. */
export function clampDockWidth(px: number, viewportWidth: number): number {
  if (!Number.isFinite(px)) return DOCK_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(px), DOCK_MIN_WIDTH), dockMaxWidth(viewportWidth));
}

/** Stored width (clamped) or the default; storage errors read as "nothing stored". */
export function readDockWidth(viewportWidth: number): number {
  const stored = readStored(DOCK_WIDTH_KEY);
  if (stored === undefined) return DOCK_DEFAULT_WIDTH;
  return clampDockWidth(Number.parseInt(stored, 10), viewportWidth);
}

/** Whether the dock was left open ("1" → true, anything else → false). */
export function readDockOpen(): boolean {
  return readStored(DOCK_OPEN_KEY) === '1';
}
