/**
 * LOU-I6: every relative markdown link under README.md's "Documentation"
 * and "Examples" headings (and every relative link inside docs/*.md)
 * resolves, from the repo root / the linking file, to a non-empty file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

function section(markdown: string, heading: string): string {
  const start = markdown.search(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (start === -1) throw new Error(`README.md has no "## ${heading}" heading`);
  const rest = markdown.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function relativeLinks(markdown: string): string[] {
  // Drop fenced code blocks so code isn't mistaken for links.
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  return [...prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href) && !href.startsWith('#'))
    .map((href) => href.split('#')[0]);
}

function expectNonEmptyTarget(fromDir: string, href: string): void {
  const target = path.resolve(fromDir, href);
  expect(fs.existsSync(target), `${href} -> ${target} exists`).toBe(true);
  const file = fs.statSync(target).isDirectory() ? path.join(target, 'README.md') : target;
  expect(fs.existsSync(file), `${href} -> ${file} exists`).toBe(true);
  expect(fs.readFileSync(file, 'utf8').trim().length, `${file} is non-empty`).toBeGreaterThan(0);
}

const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

describe('README.md documentation links', () => {
  for (const heading of ['Documentation', 'Examples']) {
    it(`every relative link under "## ${heading}" resolves to a non-empty file`, () => {
      const links = relativeLinks(section(readme, heading));
      expect(links.length).toBeGreaterThan(0);
      for (const href of links) expectNonEmptyTarget(REPO_ROOT, href);
    });
  }

  it('the Examples section links to the real examples/README.md index', () => {
    expect(relativeLinks(section(readme, 'Examples'))).toContain('examples/README.md');
  });

  it('the header nav anchors (#documentation, #examples, ...) have matching headings', () => {
    for (const heading of ['Features', 'Installation', 'Quickstart', 'Documentation', 'Examples']) {
      expect(readme).toMatch(new RegExp(`^## ${heading}\\s*$`, 'm'));
    }
  });
});

describe('docs/*.md internal links', () => {
  const docsDir = path.join(REPO_ROOT, 'docs');
  const pages = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));

  for (const page of pages) {
    it(`${page}: every relative link resolves to a non-empty file`, () => {
      const markdown = fs.readFileSync(path.join(docsDir, page), 'utf8');
      for (const href of relativeLinks(markdown)) expectNonEmptyTarget(docsDir, href);
    });
  }
});
