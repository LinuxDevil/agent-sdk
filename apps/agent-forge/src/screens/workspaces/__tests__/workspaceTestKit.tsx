import { act, type ReactNode } from 'react';
import { fixtureClient, WorkspaceApiError, type ApiClient, type JsonRouteName } from 'lousho/workspaces/client';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import { WorkspacesClientProvider } from '../workspacesClient';

export interface RecordedCall {
  name: JsonRouteName;
  input: { params?: Record<string, string>; body?: unknown };
}
export type Override = (input: RecordedCall['input'], count: number) => unknown;
export interface SpyClient extends ApiClient {
  calls: RecordedCall[];
  callsTo(name: JsonRouteName): RecordedCall[];
}

export function spyClient(overrides: Partial<Record<JsonRouteName, Override>> = {}): SpyClient {
  const base = fixtureClient();
  const calls: RecordedCall[] = [];
  const callsTo = (name: JsonRouteName) => calls.filter((c) => c.name === name);
  const call = (async (name: JsonRouteName, input: RecordedCall['input']) => {
    calls.push({ name, input: JSON.parse(JSON.stringify(input ?? {})) as RecordedCall['input'] });
    const override = overrides[name];
    if (override) return override(input, callsTo(name).length);
    return base.call(name as never, input as never);
  }) as ApiClient['call'];
  return { call, streamRunEvents: base.streamRunEvents, calls, callsTo };
}

export const conflict = (): WorkspaceApiError => new WorkspaceApiError('stale revision', 409, { currentRevision: 'rev-next' });

export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

export function renderWithClient(node: ReactNode, client: ApiClient): HTMLDivElement {
  return render(<ToastProvider><WorkspacesClientProvider client={client}>{node}</WorkspacesClientProvider></ToastProvider>);
}

export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('click: element not found');
  act(() => (el as HTMLElement).click());
}

export function typeInto(el: Element | null, value: string): void {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function buttonByName(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
}
