import { describe, it, expect } from 'vitest';
import { extractSnippets, findDeprecatedPromptUse, isRunnableByDefault } from './verify-docs-snippets';

describe('extractSnippets', () => {
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

  it('picks up fences indented under a list item and strips the indentation', () => {
    const listMd = ['- A rule:', '', '  ```ts', '  const a = {', '    b: 1,', '  };', '  ```', '- next item'].join('\n');
    const [snippet] = extractSnippets(listMd, 'docs/x.md');
    expect(snippet.line).toBe(3);
    expect(snippet.source).toBe('const a = {\n  b: 1,\n};\n');
  });
});

describe('isRunnableByDefault', () => {
  const snippet = (file: string, source: string, noRun = false) => ({ file, line: 1, source, noRun, ext: 'ts' as const });

  it('runs every quick-start snippet and any other snippet that builds its own mock provider', () => {
    expect(isRunnableByDefault(snippet('docs/quick-start.md', 'const a = 1;'))).toBe(true);
    expect(isRunnableByDefault(snippet('docs/auth.md', "createAgent({ provider: mockModel(['Hi']) });"))).toBe(true);
    expect(isRunnableByDefault(snippet('docs/auth.md', 'createAgent({ provider: createMockProvider({}) });'))).toBe(true);
    expect(isRunnableByDefault(snippet('docs/auth.md', "createAgent({ model: 'openai/gpt-4o' });"))).toBe(false);
  });

  it('honours no-run and never runs tsx', () => {
    expect(isRunnableByDefault(snippet('docs/quick-start.md', 'mockModel([])', true))).toBe(false);
    expect(isRunnableByDefault({ ...snippet('docs/quick-start.md', 'mockModel([])'), ext: 'tsx' })).toBe(false);
  });
});

describe('findDeprecatedPromptUse', () => {
  it('flags the prompt alias in a createAgent config', () => {
    expect(findDeprecatedPromptUse("createAgent({ prompt: 'x', provider });")).toEqual([1]);
    expect(findDeprecatedPromptUse("createAgent({\n  provider,\n  prompt: 'x',\n});")).toEqual([3]);
  });

  it('ignores instructions, nested prompt keys and unrelated calls', () => {
    expect(findDeprecatedPromptUse("createAgent({ instructions: 'x', tools: [t({ prompt: 'y' })] });")).toEqual([]);
    expect(findDeprecatedPromptUse("defineSchedule({ cron: '* * * * *', prompt: 'x' });")).toEqual([]);
    expect(findDeprecatedPromptUse("createAgent({ instructions: 'the prompt: a' });")).toEqual([]);
  });
});
