import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { fmtDuration } from '../../observe/format';

import { render as mount } from './render';

import { ToolCallRow } from '../ToolCallRow';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

const toggleOf = () => container.querySelector('.tool-call-toggle') as HTMLButtonElement;

const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

describe('ToolCallRow', () => {
  it('renders an error row: tinted class, sr state word, summary title, duration and time', () => {
    render(
      <ToolCallRow
        name="web-fetch"
        summary="https://example.com"
        state="error"
        durationMs={1200}
        at="2026-10-29T10:04:05Z"
      >
        <p id="detail">x</p>
      </ToolCallRow>,
    );
    const root = container.querySelector('.tool-call') as HTMLElement;
    expect(root.classList.contains('tool-call-error')).toBe(true);
    expect(root.getAttribute('data-state')).toBe('error');
    const toggle = toggleOf();
    expect(toggle.textContent?.startsWith('Failed: web-fetch')).toBe(true);
    const summary = toggle.querySelector('.tool-call-summary') as HTMLElement;
    expect(summary.getAttribute('title')).toBe('https://example.com');
    expect(summary.textContent).toBe('https://example.com');
    const meta = toggle.querySelector('.tool-call-meta') as HTMLElement;
    expect(meta.textContent).toContain(fmtDuration(1200));
    expect(meta.querySelector('time[datetime="2026-10-29T10:04:05Z"]')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#detail')).toBeNull();
  });

  it('expands on toggle click and links the body via aria-controls', () => {
    render(
      <ToolCallRow name="web-fetch" state="done">
        <p id="detail">x</p>
      </ToolCallRow>,
    );
    const toggle = toggleOf();
    click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = container.querySelector('.tool-call-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.querySelector('#detail')).not.toBeNull();
    expect(body.id).toBe(toggle.getAttribute('aria-controls'));
  });

  it('honours defaultOpen and reports the next state through onToggle', () => {
    const onToggle = vi.fn();
    render(
      <ToolCallRow name="web-fetch" state="done" defaultOpen onToggle={onToggle}>
        <p id="detail">x</p>
      </ToolCallRow>,
    );
    expect(container.querySelector('.tool-call-body #detail')).not.toBeNull();
    click(toggleOf());
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(container.querySelector('.tool-call-body')).toBeNull();
  });

  it('draws the MCP server badge before the tool name', () => {
    render(<ToolCallRow name="github_create_issue" server="github" state="done" />);
    const badge = container.querySelector('.tool-call-server') as HTMLElement;
    expect(badge.textContent).toBe('github');
    expect(badge.getAttribute('title')).toBe('MCP server github');
    expect(badge.nextElementSibling?.classList.contains('tool-call-name')).toBe(true);
  });

  it('cannot expand without children: disabled toggle, no aria-expanded, no chevron', () => {
    render(<ToolCallRow name="web-fetch" state="done" />);
    const toggle = toggleOf();
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBeNull();
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(toggle.querySelector('.tool-call-chevron')).toBeNull();
  });

  it('keeps action buttons outside the toggle so they never expand the row', () => {
    const onApprove = vi.fn();
    render(
      <ToolCallRow
        name="web-fetch"
        state="error"
        actions={
          <button id="approve" onClick={onApprove}>
            Approve anyway
          </button>
        }
      >
        <p id="detail">x</p>
      </ToolCallRow>,
    );
    const toggle = toggleOf();
    const approve = container.querySelector('#approve') as HTMLButtonElement;
    expect(toggle.contains(approve)).toBe(false);
    click(approve);
    expect(onApprove).toHaveBeenCalled();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows only the time for a running call with no duration, with sr text "Running: "', () => {
    render(<ToolCallRow name="web-fetch" state="running" at="2026-10-29T10:04:05Z" />);
    const meta = container.querySelector('.tool-call-meta') as HTMLElement;
    expect(meta.querySelector('.tabular-nums')).toBeNull();
    expect(meta.querySelector('time')).not.toBeNull();
    expect(container.querySelector('.visually-hidden')?.textContent).toBe('Running: ');
  });

  it('omits the <time> element when the timestamp does not parse', () => {
    render(<ToolCallRow name="web-fetch" state="done" at="not-a-date" />);
    expect(container.querySelector('.tool-call-meta time')).toBeNull();
  });
});
