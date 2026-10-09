import { describe, it, expect } from 'vitest';
import { extractSnippets } from './verify-docs-snippets';

describe('extractSnippets (Eve DUI-F19)', () => {
  const md = [
    '# T',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '```tsx',
    'const b = <div />;',
    '```',
    '',
    '```tsx no-verify',
    'const c = <p />;',
    '```',
    '',
    '```typescript no-run',
    'const d = 2;',
    '```',
    '',
    '```js',
    'const e = 3;',
    '```',
  ].join('\n');

  it('picks up ts, tsx and typescript fences and honours no-verify / no-run', () => {
    const snippets = extractSnippets(md, 'docs/x.md');
    expect(snippets.map((s) => [s.line, s.ext, s.noRun])).toEqual([
      [3, 'ts', false],
      [7, 'tsx', false],
      [15, 'ts', true],
    ]);
    expect(snippets[1].source).toBe('const b = <div />;\n');
  });
});
