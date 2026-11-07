import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createAgentRecord: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

// The route table is mocked so tests can switch '/templates' on and off; the
// real table has no '/templates' entry until A10 lands.
const routesState = vi.hoisted(() => ({
  routes: [] as Array<{ pattern: string; screen: string; example: string }>,
}));
vi.mock('../../routeTable', () => ({ ROUTES: routesState.routes }));

import type { AgentRecord } from '../../../../shared/wireTypes';
import { hasTemplatesRoute, useNewAgentActions } from '../newAgent';
import { NewAgentMenu, StartOptions } from '../NewAgentMenu';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

/** The components take the shared hook state as props; the screen owns the one instance. */
function MenuHarness() {
  const state = useNewAgentActions();
  return <NewAgentMenu {...state} />;
}

function OptionsHarness() {
  const state = useNewAgentActions();
  return <StartOptions {...state} />;
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  return render(
    <ToastProvider>
      {node}
    </ToastProvider>
  );
}

/** The portalled menu's rows live under document.body, outside the render host. */
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const menuItem = (label: string) =>
  menuItems().find((el) => el.textContent?.startsWith(label));

const triggerOf = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('.menu-trigger')!;

async function openMenu(host: HTMLElement) {
  await act(async () => triggerOf(host).click());
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  // The mocked ROUTES binding holds this array's identity - mutate, never reassign.
  routesState.routes.length = 0;
  api.createAgentRecord.mockResolvedValue({ id: 'untitled-1' } as AgentRecord);
  window.history.replaceState(null, '', '/#/agents');
});

describe('NewAgentMenu', () => {
  it('shows a primary "New agent" trigger that opens the four ways plus a separator', async () => {
    const host = mount(<MenuHarness />);
    const trigger = triggerOf(host);
    expect(trigger.textContent).toContain('New agent');
    expect(trigger.classList.contains('btn-primary')).toBe(true);

    await openMenu(host);
    const labels = menuItems().map((el) => el.textContent ?? '');
    expect(labels.some((t) => t.startsWith('Blank agent'))).toBe(true);
    expect(labels.some((t) => t.startsWith('Describe with AI'))).toBe(true);
    expect(labels.some((t) => t.startsWith('From template'))).toBe(true);
    expect(labels.some((t) => t.startsWith('Import from file…'))).toBe(true);
    expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('disables Describe with AI and Import with their reasons until AA19/L08 wire them', async () => {
    const host = mount(<MenuHarness />);
    await openMenu(host);

    const describe = menuItem('Describe with AI')!;
    expect(describe.getAttribute('aria-disabled')).toBe('true');
    expect(describe.getAttribute('title')).toBe('The Agent Author isn’t set up yet.');

    const importItem = menuItem('Import from file…')!;
    expect(importItem.getAttribute('aria-disabled')).toBe('true');
    expect(importItem.getAttribute('title')).toBe('Import arrives with the import sheet.');
  });

  it('hasTemplatesRoute detects the /templates route entry', () => {
    expect(hasTemplatesRoute([])).toBe(false);
    expect(
      hasTemplatesRoute([{ pattern: '/templates', screen: 'templates' as never, example: '/templates' }])
    ).toBe(true);
  });

  it('disables From template until the route exists, then navigates to #/templates', async () => {
    const host = mount(<MenuHarness />);
    await openMenu(host);
    const disabledTemplate = menuItem('From template')!;
    expect(disabledTemplate.getAttribute('aria-disabled')).toBe('true');
    expect(disabledTemplate.getAttribute('title')).toBe('Templates aren’t available yet.');
    await act(async () => disabledTemplate.click());
    expect(api.createAgentRecord).not.toHaveBeenCalled();

    // A10 registers the route: the menu item becomes runnable.
    routesState.routes.push({ pattern: '/templates', screen: 'templates', example: '/templates' });
    const host2 = mount(<MenuHarness />);
    await openMenu(host2);
    const enabledTemplate = menuItem('From template')!;
    expect(enabledTemplate.getAttribute('aria-disabled')).toBeNull();
    await act(async () => enabledTemplate.click());
    await flush();
    expect(window.location.hash).toBe('#/templates');
  });

  it('reads "Creating…" while the blank create is in flight, then opens the canvas', async () => {
    let resolveCreate!: (record: AgentRecord) => void;
    api.createAgentRecord.mockReturnValue(
      new Promise<AgentRecord>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const host = mount(<MenuHarness />);
    await openMenu(host);
    await act(async () => menuItem('Blank agent')!.click());
    await flush();

    const trigger = triggerOf(host);
    expect(trigger.textContent).toContain('Creating…');
    expect(trigger.disabled).toBe(true);

    await act(async () => resolveCreate({ id: 'untitled-1' } as AgentRecord));
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith({ from: 'blank' });
    expect(window.location.hash).toBe('#/agents/untitled-1/canvas');
    expect(trigger.disabled).toBe(false);
  });

  it('toasts the server message and re-enables the trigger when the create fails', async () => {
    api.createAgentRecord.mockRejectedValue(new Error('Disk full'));
    const host = mount(<MenuHarness />);
    await openMenu(host);
    await act(async () => menuItem('Blank agent')!.click());
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Disk full');
    const trigger = triggerOf(host);
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain('New agent');
  });
});

describe('StartOptions', () => {
  it('renders the three start buttons; disabled ones explain why; Blank creates', async () => {
    const host = mount(<OptionsHarness />);
    const group = host.querySelector('.start-options')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Ways to start');

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button.start-option')];
    expect(buttons).toHaveLength(3);
    const titles = buttons.map((b) => b.querySelector('.start-option-title')?.textContent);
    expect(titles).toEqual(['Blank agent', 'Describe with AI', 'From template']);

    const describe = buttons[1];
    expect(describe.disabled).toBe(true);
    expect(describe.getAttribute('title')).toBe('The Agent Author isn’t set up yet.');
    // The reason is part of the button's accessible description.
    const describedBy = (describe.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(describedBy).toContain('The Agent Author isn’t set up yet.');

    const template = buttons[2];
    expect(template.disabled).toBe(true);
    expect(template.getAttribute('title')).toBe('Templates aren’t available yet.');

    await act(async () => buttons[0].click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith({ from: 'blank' });
    expect(window.location.hash).toBe('#/agents/untitled-1/canvas');
  });
});
