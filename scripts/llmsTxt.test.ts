import { describe, it, expect } from 'vitest';
import {
  absoluteHref,
  extractParagraph,
  extractTitle,
  describePage,
  firstSentence,
  isUserDoc,
  normalizeNewlines,
  orderDocs,
  removeTitle,
  renderLlmsFull,
  renderLlmsTxt,
  repoBaseUrl,
  rewriteLinks,
  splitSentences,
  stripNoise,
  stripTicketIds,
} from './llmsTxt';
import type { LlmsInput } from './llmsTxt';

const BASE = 'https://github.com/o/r';

describe('repoBaseUrl', () => {
  it('turns git remotes into a browsable https URL', () => {
    expect(repoBaseUrl('https://github.com/o/r.git')).toBe(BASE);
    expect(repoBaseUrl('git+https://github.com/o/r.git')).toBe(BASE);
    expect(repoBaseUrl('git://github.com/o/r.git')).toBe(BASE);
  });
});

describe('isUserDoc', () => {
  it('keeps user pages and drops research, plan, api and maintainer notes', () => {
    expect(isUserDoc('docs/installation.md')).toBe(true);
    expect(isUserDoc('docs/research/x.md')).toBe(false);
    expect(isUserDoc('docs/plan/tickets.md')).toBe(false);
    expect(isUserDoc('docs/api/index.html')).toBe(false);
    expect(isUserDoc('docs/eslint-baseline-followup.md')).toBe(false);
    expect(isUserDoc('docs/docs-links.test.ts')).toBe(false);
  });
});

describe('extractTitle / removeTitle', () => {
  it('uses the first H1 and ignores # lines inside code fences', () => {
    const md = '```sh\n# comment\n```\n\n# Real Title\n\ntext\n';
    expect(extractTitle(md)).toBe('Real Title');
    expect(removeTitle(md)).toBe('```sh\n# comment\n```\n\n\ntext\n');
  });

  it('throws when there is no H1', () => {
    expect(() => extractTitle('## only h2')).toThrow(/no top-level/);
  });
});

describe('extractParagraph / firstSentence', () => {
  it('skips badges, comments, headings and lists to find the first prose paragraph', () => {
    const md = [
      '# T',
      '',
      '![CI](x.svg)',
      '[![npm](a.svg)](b)',
      '',
      '<!-- hidden -->',
      '',
      '- a list',
      '',
      '**Bold lead.** See [the docs](./d.md)',
      'for more. Second sentence.',
      '',
      'Later paragraph.',
    ].join('\n');
    expect(extractParagraph(md)).toBe('Bold lead. See the docs for more. Second sentence.');
  });

  it('returns an empty string when there is no prose', () => {
    expect(extractParagraph('# T\n\n- a\n- b\n')).toBe('');
  });

  it('trims to one sentence, or strips a trailing colon when there is no full stop', () => {
    expect(firstSentence('One. Two.')).toBe('One.');
    expect(firstSentence('Uses `a.b` here. Next.')).toBe('Uses `a.b` here.');
    expect(firstSentence('Run it like this:')).toBe('Run it like this');
  });
});

describe('splitSentences / describePage / stripTicketIds', () => {
  it('does not end a sentence inside brackets, braces or inline code', () => {
    const text = 'A hook is `{ name, pre? }` that runs (see a.b. Then c) in the loop. Next one.';
    expect(splitSentences(text)).toEqual([
      'A hook is `{ name, pre? }` that runs (see a.b. Then c) in the loop.',
      'Next one.',
    ]);
    expect(firstSentence('Object { a?, b? } ends here. More.')).toBe('Object { a?, b? } ends here.');
  });

  it('uses the frontmatter description when present', () => {
    expect(describePage('---\ndescription: "Does X. And Y."\n---\n# T\n\nIgnored.\n')).toBe('Does X. And Y.');
  });

  it('takes whole sentences from the opening paragraph up to the length cap, never mid-sentence', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const out = describePage(`# T\n\n${long}\n`);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('here.')).toBe(true);
    expect(out.startsWith('Sentence number 0 is here. Sentence number 1')).toBe(true);
  });

  it('strips internal LOU-* ticket ids', () => {
    expect(stripTicketIds('ops-pipeline (LOU-J8)')).toBe('ops-pipeline');
    expect(stripTicketIds('usage (LOU-B6): basic')).toBe('usage: basic');
    expect(stripTicketIds('every LOU-J primitive')).toBe('every primitive');
    expect(describePage('# T\n\nFixed in LOU-D41 already.\n')).not.toContain('LOU-');
  });
});

describe('stripNoise', () => {
  it('removes comments and badge lines but leaves code fences alone', () => {
    const md = 'a\n\n![b](x)\n\n<!-- c -->\n\n```html\n<!-- keep -->\n```\n';
    const out = stripNoise(md);
    expect(out).not.toContain('![b]');
    expect(out).toContain('<!-- keep -->');
    expect(out).not.toContain('<!-- c -->');
  });
});

describe('absoluteHref / rewriteLinks', () => {
  it('resolves relative paths against the source file', () => {
    expect(absoluteHref('./configuration.md', 'docs/x.md', BASE)).toBe(`${BASE}/blob/main/docs/configuration.md`);
    expect(absoluteHref('docs/quick-start.md', 'README.md', BASE)).toBe(`${BASE}/blob/main/docs/quick-start.md`);
    expect(absoluteHref('../examples/doc-qa/', 'docs/x.md', BASE)).toBe(`${BASE}/tree/main/examples/doc-qa`);
    expect(absoluteHref('./a.md#sec', 'docs/x.md', BASE)).toBe(`${BASE}/blob/main/docs/a.md#sec`);
  });

  it('leaves absolute URLs and pure anchors alone', () => {
    expect(absoluteHref('https://x.dev/a', 'README.md', BASE)).toBe('https://x.dev/a');
    expect(absoluteHref('mailto:a@b.c', 'README.md', BASE)).toBe('mailto:a@b.c');
    expect(absoluteHref('#top', 'README.md', BASE)).toBe('#top');
  });

  it('rewrites links in prose but not inside code fences', () => {
    const md = 'See [cfg](./c.md).\n\n```ts\nconst s = "[x](./c.md)";\n```\n';
    expect(rewriteLinks(md, 'docs/x.md', BASE)).toBe(
      `See [cfg](${BASE}/blob/main/docs/c.md).\n\n\`\`\`ts\nconst s = "[x](./c.md)";\n\`\`\`\n`,
    );
  });
});

describe('orderDocs', () => {
  it('puts installation, quick-start, api-overview first, then the rest alphabetically', () => {
    const paths = ['docs/testing.md', 'docs/api-overview.md', 'docs/agent-forge.md', 'docs/quick-start.md', 'docs/installation.md'];
    expect(orderDocs(paths.map((path) => ({ path }))).map((p) => p.path)).toEqual([
      'docs/installation.md',
      'docs/quick-start.md',
      'docs/api-overview.md',
      'docs/agent-forge.md',
      'docs/testing.md',
    ]);
  });
});

describe('normalizeNewlines', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

const INPUT: LlmsInput = {
  name: '@o/pkg',
  repositoryUrl: 'git+https://github.com/o/r.git',
  readme: { path: 'README.md', markdown: '# Pkg\n\n![b](x)\n\nA tool. More.\n\n[Go](docs/b.md)\n' },
  docs: [
    { path: 'docs/deployment.md', markdown: '# Deployment\n\nShip it. Done.\n' },
    { path: 'docs/prompting-techniques.md', markdown: '# Prompting\n\nBackground reading.\n' },
    { path: 'docs/b.md', markdown: '# B Page\n\nAbout B. See [A](./a.md).\n' },
    { path: 'docs/installation.md', markdown: '# Installation\n\nInstall it.\n' },
  ],
  examples: [{ dir: 'examples/z', readme: '# z\n\nAn example. Yes.\n' }],
};

describe('renderLlmsTxt', () => {
  it('follows the llmstxt.org layout with absolute URLs and a single trailing newline', () => {
    expect(renderLlmsTxt(INPUT)).toBe(
      [
        '# @o/pkg',
        '',
        '> A tool. More.',
        '',
        '## Docs',
        '',
        `- [Pkg](${BASE}/blob/main/README.md): A tool. More.`,
        `- [Installation](${BASE}/blob/main/docs/installation.md): Install it.`,
        `- [B Page](${BASE}/blob/main/docs/b.md): About B. See A.`,
        `- [Deployment](${BASE}/blob/main/docs/deployment.md): Ship it. Done.`,
        '',
        '## Examples',
        '',
        `- [z](${BASE}/blob/main/examples/z/README.md): An example. Yes.`,
        '',
        '## Optional',
        '',
        `- [Prompting](${BASE}/blob/main/docs/prompting-techniques.md): Background reading.`,
        '',
      ].join('\n'),
    );
  });
});

describe('renderLlmsFull', () => {
  it('concatenates README first, then docs in reading order, with headers and rewritten links', () => {
    const out = renderLlmsFull(INPUT);
    expect(out.startsWith('# Pkg\n\nSource: README.md\n\nA tool. More.')).toBe(true);
    expect(out).not.toContain('![b]');
    expect(out.indexOf('Source: docs/installation.md')).toBeLessThan(out.indexOf('Source: docs/b.md'));
    expect(out.indexOf('Source: docs/b.md')).toBeLessThan(out.indexOf('Source: docs/deployment.md'));
    expect(out).toContain(`[A](${BASE}/blob/main/docs/a.md)`);
    expect(out).toContain(`[Go](${BASE}/blob/main/docs/b.md)`);
    expect(out.endsWith('\n') && !out.endsWith('\n\n')).toBe(true);
    expect(out).not.toContain('\r');
  });
});

describe('extractParagraph on real-world shapes', () => {
  it('ignores table rows and blockquotes', () => {
    expect(extractParagraph('# T\n\n| a | b |\n|---|---|\n\n> quote\n\nReal text.\n')).toBe('Real text.');
  });
});
