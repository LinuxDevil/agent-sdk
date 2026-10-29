import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';

const appState = vi.hoisted(() => ({
  approveAgent: vi.fn(async () => {}),
  sendChatMessage: vi.fn(async () => {}),
  drawerTab: 'chat',
  setDrawerTab: vi.fn(),
  chat: {
    sessionId: 's1',
    messages: [
      { id: 'm0', role: 'system', content: 'You are helpful.', timestamp: '2026-10-29T10:00:00.000Z' },
      { id: 'm1', role: 'user', content: 'Hi', timestamp: '2026-10-29T10:00:01.000Z' },
      { id: 'm2', role: 'assistant', content: 'Hello', timestamp: '2026-10-29T10:00:02.000Z' },
    ],
  },
  logs: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }],
  spans: [],
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));
// The drawer's panels are covered elsewhere; here only its tab strip matters.
vi.mock('../ChatPanel', () => ({ ChatPanel: () => null }));

import { agentInitials } from '../LeftRail';
import { ApprovalCard } from '../ApprovalCard';
import { ChatComposer } from '../ChatComposer';
import { BottomDrawer } from '../BottomDrawer';
import { ToolbarMoreMenu } from '../ToolbarMoreMenu';

/** The accessible name a tab or button gets from its text, minus anything aria-hidden. */
function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return label;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return clone.textContent?.trim() ?? '';
}

describe('agentInitials', () => {
  it('takes the first letters of the first two words, else the first two letters', () => {
    expect(agentInitials('support-bot')).toBe('SB');
    expect(agentInitials('orders_bot_v2')).toBe('OB');
    expect(agentInitials('weather')).toBe('WE');
    expect(agentInitials('x')).toBe('X');
    expect(agentInitials('---')).toBe('?');
  });
});

describe('ApprovalCard', () => {
  it('the card shows the tool, its arguments as a JSON tree, and Approve/Reject', () => {
    const container = render(<ApprovalCard toolName="demo-approval" args={{ input: 'mock input' }} />);
    const card = container.querySelector('.approval-card')!;
    expect(card.classList.contains('approval-card-card')).toBe(true);
    expect(card.querySelector('.approval-tool')?.textContent).toBe('demo-approval');
    expect(card.querySelector('.approval-args')?.textContent).toContain('mock input');
    expect([...card.querySelectorAll('.approval-actions button')].map(nameOf)).toEqual(['Approve', 'Reject']);
    act(() => (card.querySelector('.approval-actions button') as HTMLButtonElement).click());
    expect(appState.approveAgent).toHaveBeenCalledWith(true);
  });

  it('the inline variant shows the tool name and keeps it, with the arguments, in its tooltip', () => {
    const container = render(<ApprovalCard variant="inline" toolName="http" args={{ url: 'x' }} />);
    const card = container.querySelector('.approval-card-inline')!;
    expect(card.getAttribute('title')).toBe('Approve http? {"url":"x"}');
    expect(card.querySelector('.approval-tool')?.textContent).toBe('http');
    expect(card.querySelector('.approval-text')?.textContent).toBe('Approve http?');
    expect(card.querySelector('.approval-args')).toBeNull();
  });
});

describe('ChatComposer', () => {
  it('has a Send icon button named Send, a Shift+Enter hint, and sends on Enter', () => {
    const container = render(<ChatComposer viewing={false} isPausedForApproval={false} inputDisabled={false} />);
    const send = container.querySelector('.btn-send') as HTMLButtonElement;
    expect(nameOf(send)).toBe('Send');
    expect(send.disabled).toBe(true);
    expect(container.querySelector('.chat-hint')?.textContent).toBe('Shift+Enter for newline');
    expect(container.querySelectorAll('.chat-hint kbd')).toHaveLength(2);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(textarea, 'Hello there');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(send.disabled).toBe(false);
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(appState.sendChatMessage).toHaveBeenCalledWith('Hello there');
  });
});

describe('BottomDrawer tabs', () => {
  it('show icons and counts while each tab keeps its bare label as its name', () => {
    const container = render(<BottomDrawer />);
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map(nameOf)).toEqual(['Chat', 'Logs', 'Trace', 'Output', 'History', 'Settings']);
    // The label is its own span (icon-only tabs at phone widths) and the tooltip.
    expect(tabs.map((t) => [t.querySelector('.drawer-tab-label')?.textContent, t.getAttribute('title')])).toEqual(
      ['Chat', 'Logs', 'Trace', 'Output', 'History', 'Settings'].map((l) => [l, l]),
    );
    // System messages are not counted; an empty count is not drawn.
    expect(tabs.map((t) => t.querySelector('.count')?.textContent ?? '')).toEqual(['2', '3', '', '', '', '']);
    expect(tabs.every((t) => t.querySelector('svg[aria-hidden="true"]'))).toBe(true);
    expect(container.querySelector('[role="separator"] svg.drawer-grip')).not.toBeNull();
  });
});

describe('ToolbarMoreMenu', () => {
  it('opens on its button, focuses the first item, and Escape closes it back to the button', () => {
    const onSelect = vi.fn();
    const container = render(<ToolbarMoreMenu items={[{ label: 'Debug', checked: true, onSelect }, { label: 'Import', onSelect }]} />);
    const button = container.querySelector('[aria-label="More actions"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = [...container.querySelectorAll('[role^="menuitem"]')];
    expect(items.map((i) => [i.getAttribute('role'), nameOf(i)])).toEqual([
      ['menuitemcheckbox', 'Debug'],
      ['menuitem', 'Import'],
    ]);
    expect(document.activeElement).toBe(items[0]);
    act(() => {
      container.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => {
      container.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
