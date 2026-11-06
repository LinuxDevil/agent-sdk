import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { ChangeList } from '../ChangeList';
import type { ChangeItem } from '../changeValue';
import { render } from './render';

const MODEL: ChangeItem = {
  field: 'model',
  label: 'Model',
  op: 'edit',
  before: 'anthropic/claude-haiku-5-5',
  after: 'anthropic/claude-sonnet-5-5',
};

const TOOLS: ChangeItem = {
  field: 'tools',
  label: 'Tools',
  op: 'edit',
  before: [{ builtin: 'http' }, { builtin: 'web-fetch' }],
  after: [{ builtin: 'http', approval: 'always' }, { builtin: 'current-date' }],
};

const INSTRUCTIONS: ChangeItem = {
  field: 'instructions',
  label: 'Instructions',
  op: 'edit',
  lines: [
    { kind: 'same', text: 'x' },
    { kind: 'removed', text: 'a' },
    { kind: 'added', text: 'b' },
    { kind: 'added', text: 'c' },
  ],
};

const click = (el: Element) => act(() => (el as HTMLElement).click());

describe('ChangeList', () => {
  it('renders a scalar edit as struck before → after, with the words for a screen reader', () => {
    const c = render(<ChangeList changes={[MODEL]} />);
    const row = c.querySelector('li.change-row.change-row-edit[data-field="model"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('.change-label')?.textContent).toBe('Model');
    expect(row.querySelector('.change-value')?.textContent).toBe(
      'from anthropic/claude-haiku-5-5→ to anthropic/claude-sonnet-5-5',
    );
    expect(row.querySelector('del.change-before')?.textContent).toBe('anthropic/claude-haiku-5-5');
    expect(row.querySelector('ins.change-after')?.textContent).toBe('anthropic/claude-sonnet-5-5');
    expect(row.querySelector('.change-arrow')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a collection change as added, removed and edited chips, each announcing its kind', () => {
    const c = render(<ChangeList changes={[TOOLS]} />);
    const chips = [...c.querySelectorAll('.change-chip')] as HTMLElement[];
    expect(chips.map((chip) => chip.className)).toEqual([
      'change-chip change-chip-add',
      'change-chip change-chip-remove',
      'change-chip change-chip-edit',
    ]);
    expect(chips[0].textContent).toBe('Added: current-date');
    expect(chips[1].textContent).toBe('Removed: web-fetch');
    expect(chips[2].textContent).toBe('Changed: http');
  });

  it('shows +N −M counts for a text change and toggles the line diff', () => {
    const c = render(<ChangeList changes={[INSTRUCTIONS]} />);
    expect(c.querySelector('.change-count-add')?.textContent).toBe('+2');
    expect(c.querySelector('.change-count-remove')?.textContent).toBe('−1');
    const toggle = c.querySelector('button.change-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show diff');
    expect(c.querySelector('pre.change-diff')).toBeNull();

    click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide diff');
    const pre = c.querySelector('pre.change-diff') as HTMLElement;
    const lines = pre.querySelectorAll('.change-line');
    expect(lines).toHaveLength(4);
    expect(lines[1].classList.contains('change-line-removed')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(pre.id);
  });

  it('starts the text diff expanded when expandText is set', () => {
    const c = render(<ChangeList changes={[INSTRUCTIONS]} expandText />);
    expect(c.querySelector('pre.change-diff')).not.toBeNull();
    expect(c.querySelector('button.change-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders only the title row and the empty text for no changes', () => {
    const c = render(<ChangeList changes={[]} />);
    expect(c.querySelector('p.change-list-empty')?.textContent).toBe('No changes.');
    expect(c.querySelector('.change-list-count')?.textContent).toBe('0');
    expect(c.querySelector('.change-list-rows')).toBeNull();
  });

  it('groups rows under an h4 per groupBy key in first-appearance order', () => {
    const c = render(
      <ChangeList changes={[MODEL, TOOLS]} groupBy={(change) => (change.field === 'model' ? 'Model' : 'Tools')} />,
    );
    const headings = [...c.querySelectorAll('h4.change-list-group')].map((h) => h.textContent);
    expect(headings).toEqual(['Model', 'Tools']);
  });

  it('labels the section with the title h3', () => {
    const c = render(<ChangeList changes={[MODEL]} />);
    const section = c.querySelector('section.change-list') as HTMLElement;
    const title = section.querySelector('h3.change-list-title') as HTMLElement;
    expect(section.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.textContent).toContain('Changes');
  });
});
