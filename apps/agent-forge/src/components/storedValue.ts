/**
 * Per-viewer UI preferences in localStorage (Inspector sections, drawer
 * height). Storage can be missing or throw (private mode, blocked site
 * data), so a failed read is "nothing stored" and a failed write is dropped.
 */
export function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Stores `value` under `key`, ignoring a storage that throws. */
export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered this time; the UI still works.
  }
}
