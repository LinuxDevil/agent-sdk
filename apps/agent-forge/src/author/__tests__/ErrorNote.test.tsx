import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { ErrorNote } from '../ErrorNote';
import { render } from '../../ui/__tests__/render';

describe('ErrorNote', () => {
  it('renders the message in an alert with the icon', () => {
    const c = render(<ErrorNote message="Couldn't save the agent." />);
    const note = c.querySelector('.error-note');
    expect(note?.getAttribute('role')).toBe('alert');
    expect(note?.querySelector('svg')).not.toBeNull();
    expect(c.querySelector('.error-note span')?.textContent).toBe("Couldn't save the agent.");
  });

  it('renders no button without an action', () => {
    const c = render(<ErrorNote message="Boom." />);
    expect(c.querySelector('button')).toBeNull();
  });

  it('renders the action button and fires its handler', () => {
    const onClick = vi.fn();
    const c = render(<ErrorNote message="The reply failed." action={{ label: 'Try again', onClick }} />);
    const button = c.querySelector<HTMLButtonElement>('.error-note button')!;
    expect(button.textContent).toBe('Try again');
    expect(button.className).toContain('btn-ghost');
    act(() => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
