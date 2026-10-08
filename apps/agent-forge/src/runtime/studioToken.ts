/**
 * Eve DUI-F1: the per-launch API token `lousho studio` prints in its URL
 * (`http://127.0.0.1:4750/?token=...`). Read once from the page URL, kept in
 * `sessionStorage` so a reload of this tab still works, and stripped from
 * the address bar. Every API call and the WebSocket send it back (see
 * runtimeClient.ts and server/auth.ts).
 */
export const STUDIO_TOKEN_HEADER = 'x-lousho-studio-token';
const STORAGE_KEY = 'lousho-studio-token';

function readStored(): string | undefined {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage blocked: the token still lives in memory for this page load.
  }
}

/** Picks the token off `window.location` (and removes it from the URL), else the one this tab stored earlier. */
export function loadStudioToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    store(fromUrl);
    url.searchParams.delete('token');
    try {
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Not fatal: the token just stays visible in the address bar.
    }
    return fromUrl;
  }
  return readStored();
}
