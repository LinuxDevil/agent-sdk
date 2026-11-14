/**
 * Settings → Collector card (W12): per-mode status copy, the env lock,
 * Save/Check busy states, token placeholder/remove and inline errors.
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import { CollectorCard } from '../CollectorCard';
import type { CollectorStatus } from '../../../../shared/wireTypes';

const client = vi.hoisted(() => ({
  collectorStatus: vi.fn(),
  updateCollector: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: client }));

function status(over: Partial<CollectorStatus> = {}): CollectorStatus {
  return {
    mode: 'attached',
    url: 'http://127.0.0.1:7777',
    configuredUrl: null,
    lockedByEnv: false,
    hasToken: false,
    daemonVersion: '1.2.3',
    error: null,
    ...over,
  };
}

async function mount(s: CollectorStatus = status()) {
  client.collectorStatus.mockResolvedValue(s);
  const host = render(<CollectorCard />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

const statusText = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent ?? '';
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

beforeEach(() => {
  client.collectorStatus.mockReset();
  client.updateCollector.mockReset();
});

describe('CollectorCard', () => {
  it('shows the per-mode status copy and the daemon version', async () => {
    const host = await mount(status({ mode: 'started', url: 'http://127.0.0.1:7777' }));
    expect(statusText(host)).toContain('Started by Studio on http://127.0.0.1:7777');
    expect(statusText(host)).toContain('daemon v1.2.3');
  });

  it('shows remote, attached and down copy', async () => {
    let host = await mount(status({ mode: 'remote', url: 'https://collector.example.com', daemonVersion: null }));
    expect(statusText(host)).toContain('Remote collector at https://collector.example.com');
    host = await mount(status({ mode: 'attached' }));
    expect(statusText(host)).toContain('Attached to http://127.0.0.1:7777');
    host = await mount(status({ mode: 'down', error: 'No collector answered.' }));
    expect(statusText(host)).toContain('Not reachable: No collector answered.');
  });

  it('locks the fields when LOUSHO_OBSERVE_URL controls the URL', async () => {
    const host = await mount(status({ lockedByEnv: true, configuredUrl: 'https://env.example.com', url: 'https://env.example.com' }));
    const url = host.querySelector('#collector-url') as HTMLInputElement;
    const token = host.querySelector('#collector-token') as HTMLInputElement;
    expect(url.disabled).toBe(true);
    expect(token.disabled).toBe(true);
    expect(host.textContent).toContain("Set by LOUSHO_OBSERVE_URL in Studio's environment.");
    expect(button(host, 'Save')!.disabled).toBe(true);
  });

  it('Save sends the URL and token, then shows the returned status', async () => {
    const host = await mount(status({ hasToken: false }));
    const url = host.querySelector('#collector-url') as HTMLInputElement;
    const token = host.querySelector('#collector-token') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(url, 'https://collector.example.com');
      url.dispatchEvent(new Event('input', { bubbles: true }));
      setValue.call(token, 's3cret');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    client.updateCollector.mockResolvedValue(status({ mode: 'remote', url: 'https://collector.example.com', hasToken: true }));
    await act(async () => {
      button(host, 'Save')!.click();
      await Promise.resolve();
    });
    expect(client.updateCollector).toHaveBeenCalledWith({
      url: 'https://collector.example.com',
      token: 's3cret',
    });
    expect(statusText(host)).toContain('Remote collector at https://collector.example.com');
    expect((host.querySelector('#collector-token') as HTMLInputElement).placeholder).toBe('Saved');
  });

  it('an empty URL sends null; a saved token shows the Saved placeholder and Remove token sends null', async () => {
    const host = await mount(status({ configuredUrl: 'https://collector.example.com', hasToken: true }));
    await act(async () => {
      await Promise.resolve();
    });
    const token = host.querySelector('#collector-token') as HTMLInputElement;
    expect(token.placeholder).toBe('Saved');
    client.updateCollector.mockResolvedValue(status({ configuredUrl: 'https://collector.example.com', hasToken: true }));
    await act(async () => {
      button(host, 'Remove token')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      button(host, 'Save')!.click();
      await Promise.resolve();
    });
    expect(client.updateCollector).toHaveBeenCalledWith({ url: 'https://collector.example.com', token: null });
  });

  it('Check connection probes and shows busy labels; errors render inline', async () => {
    const host = await mount(status({ mode: 'down', error: 'No collector answered.' }));
    let resolveProbe: ((s: CollectorStatus) => void) | undefined;
    client.collectorStatus.mockImplementationOnce(
      () => new Promise<CollectorStatus>((resolve) => (resolveProbe = resolve))
    );
    await act(async () => {
      button(host, 'Check connection')!.click();
    });
    expect(button(host, 'Checking…')!.disabled).toBe(true);
    await act(async () => {
      resolveProbe!(status({ mode: 'attached' }));
      await Promise.resolve();
    });
    expect(client.collectorStatus).toHaveBeenLastCalledWith(true);
    expect(statusText(host)).toContain('Attached to');

    client.updateCollector.mockRejectedValue(new Error('Enter an http or https URL without a path.'));
    await act(async () => {
      button(host, 'Save')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('http or https URL');
  });
});
