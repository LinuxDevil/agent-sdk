import { vi } from 'vitest';

/** In-memory Storage: jsdom's localStorage is unavailable under this Node (see HttpAgentStore.test.ts). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

/** Installs a fresh, empty in-memory `window.localStorage`. */
export function installMemoryStorage(): Storage {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return storage;
}

/** Makes every `window.localStorage` read and write throw, as blocked site data does. */
export function breakStorage(): void {
  for (const method of ['getItem', 'setItem'] as const) {
    vi.spyOn(window.localStorage, method).mockImplementation(() => {
      throw new Error('blocked');
    });
  }
}
