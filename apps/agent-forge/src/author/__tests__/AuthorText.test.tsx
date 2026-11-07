import { describe, it, expect } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { AuthorText } from '../AuthorText';

const paras = (c: HTMLElement) => [...c.querySelectorAll('p')].map((p) => p.textContent);

describe('AuthorText', () => {
  it('splits paragraphs on blank lines', () => {
    const c = render(<AuthorText text={'First line.\n\nSecond line.\n\n\nThird.'} />);
    expect(paras(c)).toEqual(['First line.', 'Second line.', 'Third.']);
  });

  it('renders a fenced block as pre.author-code and keeps its newlines', () => {
    const c = render(<AuthorText text={'Try this:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.'} />);
    const pre = c.querySelector('pre.author-code');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('const a = 1;\nconst b = 2;\n');
    expect(paras(c)).toEqual(['Try this:', 'Done.']);
  });

  it('renders an unclosed fence (a streaming code block) as code', () => {
    const c = render(<AuthorText text={'Here:\n\n```\npartial code'} />);
    const pre = c.querySelector('pre.author-code');
    expect(pre?.textContent).toBe('partial code');
  });

  it('renders inline code as <code> inside a paragraph', () => {
    const c = render(<AuthorText text={'Run `lousho studio` then open it.'} />);
    const code = c.querySelector('p code');
    expect(code?.textContent).toBe('lousho studio');
    expect(c.querySelector('p')?.textContent).toBe('Run lousho studio then open it.');
  });

  it('keeps <script> as text - model output is never HTML', () => {
    const c = render(<AuthorText text={'Ignore <script>alert(1)</script> and `<b>x</b>`.'} />);
    expect(c.querySelector('script')).toBeNull();
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<script>alert(1)</script>');
    expect(c.querySelector('code')?.textContent).toBe('<b>x</b>');
  });
});
