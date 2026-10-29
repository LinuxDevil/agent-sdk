import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { SettingsPanel } from '../SettingsPanel';
import { toggleTheme } from '../../shell/theme';
import type { ProviderKeyStatus } from '../../../shared/wireTypes';

const keys = vi.hoisted(() => ({ list: [] as ProviderKeyStatus[] }));

vi.mock('../../state/AppState', () => ({
  useAppState: () => ({ agentId: 'a1', refreshActiveProfile: async () => undefined }),
}));
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    listProviderKeys: async () => keys.list,
    listSettingsProfiles: async () => ({ activeProfileId: 'local', profiles: [] }),
    listDeployAdapters: async () => ['node-server'],
  },
}));
vi.mock('../../shell/DaemonStatus', () => ({
  useCollectorStatus: () => ({ state: 'down', target: undefined }),
}));

async function mount(variant?: 'drawer' | 'screen') {
  const host = render(<SettingsPanel variant={variant} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

const sectionNames = (host: HTMLElement) =>
  [...host.querySelectorAll('section.settings-card')].map((s) => s.getAttribute('aria-label'));

const keyPill = (host: HTMLElement, label: string) =>
  host.querySelector(`input[aria-label="${label}"]`)?.closest('.settings-key')?.querySelector('.status-pill')?.textContent;

const button = (scope: Element, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

beforeEach(() => {
  keys.list = [];
  installMemoryStorage();
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  window.localStorage.clear();
});

describe('SettingsPanel', () => {
  it('the drawer keeps to the agent-relevant cards', async () => {
    const host = await mount();
    expect(sectionNames(host)).toEqual(['Provider keys', 'Settings profile', 'Deploy target']);
  });

  it('the routed screen adds Appearance, Collector and Keyboard shortcuts', async () => {
    const host = await mount('screen');
    expect(sectionNames(host)).toEqual([
      'Appearance',
      'Provider keys',
      'Settings profile',
      'Deploy target',
      'Collector',
      'Keyboard shortcuts',
    ]);
    expect(host.querySelector('.settings-panel-screen')).not.toBeNull();
  });

  it('shows Set (with the masked value) or From environment (a static info pill), never pre-filling the input', async () => {
    keys.list = [
      { provider: 'openai', hasKey: true, masked: '••••3f2a', envKey: true },
      { provider: 'anthropic', hasKey: false, masked: null, envKey: true },
    ];
    const host = await mount();
    expect(keyPill(host, 'OpenAI API key')).toBe('Set');
    expect(host.querySelector('.settings-key-masked')?.textContent).toBe('••••3f2a');
    expect(keyPill(host, 'Anthropic API key')).toBe('From environment');
    const envPill = host.querySelector('input[aria-label="Anthropic API key"]')?.closest('.settings-key')?.querySelector('.status-pill');
    expect(envPill?.classList.contains('pill-info')).toBe(true);
    expect((host.querySelector('input[aria-label="OpenAI API key"]') as HTMLInputElement).value).toBe('');
  });

  it('shows Not set when there is neither a stored key nor the env var', async () => {
    keys.list = [{ provider: 'openai', hasKey: false, masked: null, envKey: false }];
    const host = await mount();
    expect(keyPill(host, 'OpenAI API key')).toBe('Not set');
    expect(keyPill(host, 'Anthropic API key')).toBe('Not set');
  });

  it('the theme control sets the choice and follows the palette toggle', async () => {
    const host = await mount('screen');
    const theme = host.querySelector('[role="group"][aria-label="Theme"]')!;
    const pressed = () => theme.querySelector('[aria-pressed="true"]')?.textContent;
    expect(pressed()).toBe('System');
    act(() => button(theme, 'Dark').click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(pressed()).toBe('Dark');
    act(() => toggleTheme());
    expect(pressed()).toBe('Light');
  });

  it('density starts unpicked with a hint, then remembers the pick', async () => {
    const host = await mount('screen');
    const group = host.querySelector('[role="group"][aria-label="Table density"]')!;
    expect(group.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(host.textContent).toContain("Tables use each screen's default until you pick one.");
    const comfy = button(group, 'Comfortable');
    act(() => comfy.click());
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable');
    expect(window.localStorage.getItem('forge.density')).toBe('comfortable');
    expect(comfy.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).not.toContain("until you pick one");

    act(() => button(host, 'Reset to screen defaults').click());
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
    expect(window.localStorage.getItem('forge.density')).toBeNull();
    expect(group.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(host.textContent).toContain("Tables use each screen's default until you pick one.");
  });

  it('the collector card says how to start a daemon that is down, and lists every shortcut', async () => {
    const host = await mount('screen');
    const collector = host.querySelector('section[aria-label="Collector"]')!;
    expect(collector.querySelector('[role="status"]')?.textContent).toContain('Unreachable');
    expect(collector.textContent).toContain('lousho observe start');
    const shortcuts = host.querySelector('section[aria-label="Keyboard shortcuts"]')!;
    expect([...shortcuts.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Ctrl/Cmd+K',
      '?',
      'j',
      'k',
      'Enter',
      'Esc',
    ]);
  });
});
