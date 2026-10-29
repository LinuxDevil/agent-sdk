import { describe, expect, it } from 'vitest';

import { Skeleton, SkeletonRows } from '../Skeleton';
import { render } from './render';

describe('Skeleton', () => {
  it('is a decorative, aria-hidden block sized by number (px) or CSS string', () => {
    const c = render(<Skeleton width={120} height="1.5em" />);
    const el = c.querySelector('.skeleton') as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('1.5em');
    expect(el.style.borderRadius).toBe('var(--radius-sm)');
    expect(c.querySelector('[role="status"]')).toBeNull();
  });

  it('takes a radius and a className', () => {
    const c = render(<Skeleton radius="var(--radius-full)" className="avatar" />);
    const el = c.querySelector('.skeleton') as HTMLElement;
    expect(el.classList.contains('avatar')).toBe(true);
    expect(el.style.borderRadius).toBe('var(--radius-full)');
  });
});

describe('SkeletonRows', () => {
  it('renders rows x cols aria-hidden blocks plus one visually-hidden "Loading" status', () => {
    const c = render(<SkeletonRows rows={4} cols={3} />);
    expect(c.querySelectorAll('.skeleton-row')).toHaveLength(4);
    expect(c.querySelectorAll('.skeleton')).toHaveLength(12);
    for (const s of c.querySelectorAll('.skeleton')) expect(s.getAttribute('aria-hidden')).toBe('true');
    const status = c.querySelectorAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0].textContent).toBe('Loading');
    expect(status[0].classList.contains('visually-hidden')).toBe(true);
  });

  it('defaults to six rows of one column', () => {
    const c = render(<SkeletonRows />);
    expect(c.querySelectorAll('.skeleton-row')).toHaveLength(6);
    expect(c.querySelectorAll('.skeleton')).toHaveLength(6);
  });

  it('renders table rows (one status in the first cell) when as="tr"', () => {
    const c = render(
      <table>
        <tbody>
          <SkeletonRows as="tr" rows={2} cols={3} cellClassName={(i) => (i === 2 ? 'dt-right' : undefined)} />
        </tbody>
      </table>,
    );
    const trs = c.querySelectorAll('tbody tr.skeleton-row');
    expect(trs).toHaveLength(2);
    expect(trs[0].querySelectorAll('td')).toHaveLength(3);
    expect(trs[0].querySelectorAll('td')[2].classList.contains('dt-right')).toBe(true);
    expect(c.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(trs[0].querySelector('[role="status"]')?.textContent).toBe('Loading');
    expect(trs[1].getAttribute('aria-hidden')).toBe('true');
  });
});
