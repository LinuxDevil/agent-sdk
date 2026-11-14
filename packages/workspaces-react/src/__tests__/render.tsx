import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

export function cleanup(): void {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
}

export function render(node: ReactNode): HTMLDivElement {
  cleanup();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

export async function flush(times = 5): Promise<void> {
  for (let index = 0; index < times; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export function labelled(container: HTMLElement, text: string): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((item) => item.textContent === text);
  const target = label === undefined ? null : document.getElementById(label.htmlFor);
  if (target === null) throw new Error(`no control labelled ${text}`);
  return target;
}

export function typeInto(input: HTMLElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function choose(select: HTMLElement, text: string): void {
  const element = select as HTMLSelectElement;
  const option = [...element.options].find((item) => item.textContent === text);
  if (option === undefined) throw new Error(`no option ${text}`);
  act(() => {
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

export function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (button === undefined) throw new Error(`no button ${text}`);
  return button;
}

afterEach(cleanup);
