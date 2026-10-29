/** localStorage key holding the user's explicit theme choice. */
const THEME_KEY = 'forge.theme';
/** localStorage key holding the user's table density choice; absent = each screen's default. */
const DENSITY_KEY = 'forge.density';
/** Window event fired after the theme changes from here, so a mounted Settings control can re-read it. */
export const THEME_EVENT = 'forge:theme';

type Theme = 'light' | 'dark';

/** The Settings screen's theme choice: a forced scheme, or `system` (follow the OS). */
export type ThemeChoice = Theme | 'system';

/** Table row density: `compact` 32px rows, `comfortable` 40px rows. */
export type Density = 'compact' | 'comfortable';

const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';
const isDensity = (v: unknown): v is Density => v === 'compact' || v === 'comfortable';

/** The scheme currently in effect: the forced `<html data-theme>`, else the OS preference. */
function effectiveTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (isTheme(attr)) return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Write (or with `null` remove) one remembered preference; blocked storage still applies for this page load. */
function store(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the change still applies for this page load
  }
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked: nothing remembered
  }
}

/** Force the opposite of the current effective scheme and remember the choice. */
export function toggleTheme(): void {
  setThemeChoice(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

/** Re-apply a theme remembered by {@link toggleTheme}; call once at startup. */
export function applyStoredTheme(): void {
  const stored = read(THEME_KEY);
  if (isTheme(stored)) document.documentElement.setAttribute('data-theme', stored);
}

/** The current theme choice: the forced `<html data-theme>` scheme, else `system`. */
export function getThemeChoice(): ThemeChoice {
  const attr = document.documentElement.getAttribute('data-theme');
  return isTheme(attr) ? attr : 'system';
}

/**
 * Apply and remember a theme choice: `light`/`dark` force `<html data-theme>`
 * and store it; `system` removes both, so the OS preference applies.
 * Fires {@link THEME_EVENT} on window.
 */
export function setThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  store(THEME_KEY, choice === 'system' ? null : choice);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The stored table density, or `null` when none is picked (each screen keeps its default). */
export function getDensity(): Density | null {
  const attr = document.documentElement.getAttribute('data-density');
  return isDensity(attr) ? attr : null;
}

/** Apply and remember a table density as `<html data-density>`; `null` clears both. */
export function setDensity(density: Density | null): void {
  const root = document.documentElement;
  if (density === null) root.removeAttribute('data-density');
  else root.setAttribute('data-density', density);
  store(DENSITY_KEY, density);
}

/** Re-apply a density remembered by {@link setDensity}; call once at startup. */
export function applyStoredDensity(): void {
  const stored = read(DENSITY_KEY);
  if (isDensity(stored)) document.documentElement.setAttribute('data-density', stored);
}
