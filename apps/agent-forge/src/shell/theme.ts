/** localStorage key holding the user's explicit theme choice. */
const THEME_KEY = 'forge.theme';

type Theme = 'light' | 'dark';

const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

/** The scheme currently in effect: the forced `<html data-theme>`, else the OS preference. */
function effectiveTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (isTheme(attr)) return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Force the opposite of the current effective scheme and remember the choice. */
export function toggleTheme(): void {
  const next: Theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // storage blocked: the toggle still applies for this page load
  }
}

/** Re-apply a theme remembered by {@link toggleTheme}; call once at startup. */
export function applyStoredTheme(): void {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (isTheme(stored)) document.documentElement.setAttribute('data-theme', stored);
  } catch {
    // storage blocked: fall back to the OS preference
  }
}
