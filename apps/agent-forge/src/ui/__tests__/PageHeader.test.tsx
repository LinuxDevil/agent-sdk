import { describe, expect, it } from 'vitest';
import { render } from './render';
import { PageHeader } from '../PageHeader';

describe('PageHeader', () => {
  it('renders the title as the h1, with no optional parts by default', () => {
    const el = render(<PageHeader title="Traces" />);
    const h1 = el.querySelector('header.page-header h1');
    expect(h1?.textContent).toBe('Traces');
    expect(h1?.getAttribute('title')).toBe('Traces');
    expect(el.querySelector('nav')).toBeNull();
    expect(el.querySelector('.page-header-description')).toBeNull();
    expect(el.querySelector('.page-header-status')).toBeNull();
    expect(el.querySelector('.page-header-actions')).toBeNull();
  });

  it('renders breadcrumbs (last is the current page), description, status and actions', () => {
    const el = render(
      <PageHeader
        className="extra"
        title={<span>Dataset one</span>}
        description="Examples to evaluate against"
        breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Datasets', href: '#/evals/datasets' }, { label: 'one' }]}
        status={<span id="pill">ok</span>}
        actions={<button type="button">New example</button>}
      />,
    );
    expect(el.querySelector('header')?.className).toBe('page-header extra');
    const crumbs = el.querySelector('nav[aria-label="Breadcrumb"]')!;
    expect([...crumbs.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Evaluations', 'Datasets', 'one']);
    expect([...crumbs.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#/evals/scores', '#/evals/datasets']);
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('one');
    expect(crumbs.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
    // A non-string title gets no tooltip.
    expect(el.querySelector('h1')?.hasAttribute('title')).toBe(false);
    expect(el.querySelector('.page-header-description')?.textContent).toBe('Examples to evaluate against');
    expect(el.querySelector('.page-header-status #pill')).not.toBeNull();
    expect(el.querySelector('.page-header-actions button')?.textContent).toBe('New example');
  });

  it('a last crumb with an href is still the current page, not a link', () => {
    const el = render(<PageHeader title="x" breadcrumbs={[{ label: 'Prompts', href: '#/prompts' }]} />);
    expect(el.querySelector('nav a')).toBeNull();
    expect(el.querySelector('nav [aria-current="page"]')?.textContent).toBe('Prompts');
  });
});
