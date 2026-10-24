import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from './render';

import { MessageView } from '../MessageView';
import { JsonView } from '../JsonView';

const CHAT = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"temp":4}' },
  { role: 'assistant', content: 'It is 4 degrees.' },
];

const bubbles = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.mv-bubble')];
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const click = (el: HTMLElement | undefined) => {
  expect(el).toBeDefined();
  act(() => el!.click());
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MessageView', () => {
  it('renders an OpenAI-style message array as role-labelled bubbles with tool-call chips', () => {
    const c = render(<MessageView value={JSON.stringify(CHAT)} label="Input" />);
    const list = bubbles(c);
    expect(list.map((b) => b.dataset.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(list.map((b) => b.querySelector('.mv-role')?.textContent)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(list[1].textContent).toContain('Weather in Oslo?');
    const chips = [...list[2].querySelectorAll('.mv-chip')];
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain('get_weather');
    expect(list[3].textContent).toContain('call_1');
    expect(c.querySelector('.mv-label')?.textContent).toBe('Input');
  });

  it('accepts an object with a messages array', () => {
    const c = render(<MessageView value={JSON.stringify({ model: 'x', messages: CHAT.slice(0, 2) })} />);
    expect(bubbles(c).map((b) => b.dataset.role)).toEqual(['system', 'user']);
  });

  it('renders a plain string as text, with no JSON mode', () => {
    const c = render(<MessageView value="hello there" />);
    expect(c.querySelector('.mv-text')?.textContent).toBe('hello there');
    expect(bubbles(c)).toHaveLength(0);
    expect(button(c, 'JSON')).toBeUndefined();
  });

  it('Raw shows the exact string', () => {
    const raw = JSON.stringify(CHAT, null, 2);
    const c = render(<MessageView value={raw} />);
    click(button(c, 'Raw'));
    expect(c.querySelector('pre.mv-raw')?.textContent).toBe(raw);
    expect(bubbles(c)).toHaveLength(0);
  });

  it('JSON mode shows a JsonView of the parsed value', () => {
    const c = render(<MessageView value={JSON.stringify(CHAT)} />);
    click(button(c, 'JSON'));
    expect(bubbles(c)).toHaveLength(0);
    expect(c.querySelector('.json-node')).not.toBeNull();
  });

  it('renders non-message JSON through JsonView', () => {
    const c = render(<MessageView value='{"answer":42}' />);
    expect(c.querySelector('.json-key')?.textContent).toContain('answer');
    expect(c.querySelector('.json-num')?.textContent).toBe('42');
  });

  it('collapses JSON deeper than 4 levels', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: 'hidden' } } } } };
    const c = render(<MessageView value={JSON.stringify(deep)} />);
    const text = c.textContent ?? '';
    expect(text).toContain('l4');
    expect(text).not.toContain('l5');
    expect(text).not.toContain('hidden');
  });

  it('renders null and empty values as a muted empty line', () => {
    for (const value of [null, '']) {
      const c = render(<MessageView value={value} label="Output" />);
      expect(c.querySelector('.mv-empty')?.textContent).toBe('empty');
    }
  });

  it('renders a 64 KB string without blocking, behind a Show all button', () => {
    const big = 'x'.repeat(64 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={big} />);
    expect(performance.now() - start).toBeLessThan(50);
    expect(c.querySelector('.mv-text')!.textContent!.length).toBeLessThan(big.length);
    click(button(c, 'Show all (64 KB)'));
    expect(c.querySelector('.mv-text')?.textContent).toBe(big);
  });

  it('renders 64 KB of truncated JSON as text without blocking', () => {
    const truncated = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ i, s: 'abcdefgh' }))).slice(0, 64 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={truncated} />);
    expect(performance.now() - start).toBeLessThan(50);
    expect(c.querySelector('.mv-text')).not.toBeNull();
    expect(button(c, 'JSON')).toBeUndefined();
  });

  it('stringifies non-string tool-call fields instead of crashing', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', name: { odd: 1 } }], tool_calls: [{ id: 7, function: { name: 9, arguments: { city: 'Oslo' } } }] },
      { role: 'tool', tool_call_id: 42, content: 'ok' },
    ];
    const c = render(<MessageView value={JSON.stringify(msgs)} />);
    const chips = [...c.querySelectorAll('.mv-chip')].map((el) => el.textContent);
    expect(chips).toEqual(['{"odd":1}', '9{"city":"Oslo"}']);
    expect(c.querySelector('.mv-call-id')?.textContent).toBe('42');
  });

  it('renders ~64 KB of valid JSON within the budget', () => {
    const big = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ i, s: 'abcdefgh' })));
    expect(big.length).toBeGreaterThan(60 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={big} />);
    expect(performance.now() - start).toBeLessThan(50);
    expect(c.querySelector('.json-node')).not.toBeNull();
  });

  it('copies the exact block string with the copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const raw = JSON.stringify(CHAT);
    const c = render(<MessageView value={raw} label="Input" />);
    await act(async () => {
      button(c, 'Copy')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(button(c, 'Copied')).toBeDefined();
  });

  it('does not throw when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const c = render(<MessageView value="text" />);
    await act(async () => {
      button(c, 'Copy')!.click();
    });
    expect(button(c, 'Copy failed')).toBeDefined();
  });
});

describe('JsonView', () => {
  it('expands four levels by default and lets a collapsed level open', () => {
    const c = render(<JsonView value={{ a: { b: { c: { d: { e: 1 } } } } }} />);
    expect([...c.querySelectorAll('.json-key')].map((k) => k.textContent)).toEqual(['a: ', 'b: ', 'c: ', 'd: ']);
    expect(c.querySelector('.json-num')).toBeNull();
    const collapsed = [...c.querySelectorAll<HTMLButtonElement>('.json-toggle')].find(
      (b) => b.getAttribute('aria-expanded') === 'false',
    );
    expect(collapsed?.getAttribute('aria-label')).toBe('Toggle d');
    click(collapsed);
    expect(collapsed?.getAttribute('aria-label')).toBe('Toggle d');
    expect(c.querySelector('.json-num')?.textContent).toBe('1');
  });

  it('caps a large container at 100 entries with a Show more row', () => {
    const c = render(<JsonView value={Array.from({ length: 250 }, (_, i) => i)} />);
    expect(c.querySelectorAll('.json-num')).toHaveLength(100);
    click(button(c, 'Show 150 more'));
    expect(c.querySelectorAll('.json-num')).toHaveLength(250);
  });

  it('honours an explicit defaultExpandDepth', () => {
    const c = render(<JsonView value={{ a: { b: 1 } }} defaultExpandDepth={1} />);
    expect(c.querySelector('.json-num')).toBeNull();
  });
});
