import { describe, expect, it } from 'vitest';

import { Card } from '../Card';
import { render } from './render';

describe('Card', () => {
  it('renders a section whose header title labels it, with description and actions', () => {
    const c = render(
      <Card title="Fleet" description="Agents seen in the window" actions={<button type="button">Refresh</button>}>
        <p>body</p>
      </Card>,
    );
    const card = c.querySelector('section.card') as HTMLElement;
    const title = card.querySelector('.card-header h2.card-title') as HTMLElement;
    expect(title.textContent).toBe('Fleet');
    expect(title.id).not.toBe('');
    expect(card.getAttribute('aria-labelledby')).toBe(title.id);
    expect(card.querySelector('.card-description')?.textContent).toBe('Agents seen in the window');
    expect(card.querySelector('.card-actions button')?.textContent).toBe('Refresh');
    expect(card.querySelector('.card-body p')?.textContent).toBe('body');
    expect(card.classList.contains('card-pad-md')).toBe(true);
  });

  it('renders no header without a title, and no aria-labelledby', () => {
    const c = render(
      <Card as="div" padding="none" className="extra">
        <table />
      </Card>,
    );
    const card = c.querySelector('div.card') as HTMLElement;
    expect(card.querySelector('.card-header')).toBeNull();
    expect(card.hasAttribute('aria-labelledby')).toBe(false);
    expect(card.classList.contains('card-pad-none')).toBe(true);
    expect(card.classList.contains('extra')).toBe(true);
  });

  it('a titled div card keeps its header but is not labelled by it', () => {
    const c = render(
      <Card as="div" title="Plain">
        x
      </Card>,
    );
    const card = c.querySelector('div.card') as HTMLElement;
    expect(card.querySelector('.card-title')?.textContent).toBe('Plain');
    expect(card.hasAttribute('aria-labelledby')).toBe(false);
  });
});
