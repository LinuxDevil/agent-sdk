import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

/**
 * Mount `node` into a fresh container attached to `document.body` and return
 * the container. Any previous mount is torn down first, and the last one after each test.
 */
export function render(node: ReactNode): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

/** Re-render the current mount with `node` (keeps component state). */
export function rerender(node: ReactNode): void {
  act(() => root!.render(node));
}

/** Unmount and detach the current mount (also runs automatically after each test). */
export function cleanup(): void {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
}

afterEach(cleanup);
