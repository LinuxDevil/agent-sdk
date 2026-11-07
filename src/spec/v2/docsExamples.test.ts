/**
 * docs/agent-spec.md is the AgentSpec v2 reference. Every ```yaml fence on it
 * that starts with `version: 2` must parse through parseAgentSpecV2 (a reader
 * copies the block verbatim), and every relative `./<file>.md` link must
 * point at a real docs page. Kept next to the schema so a spec change that
 * breaks the documented examples fails here, not in a reader's project.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseAgentSpecV2 } from './parse';

const docsDir = path.resolve(__dirname, '../../../docs');
const page = readFileSync(path.join(docsDir, 'agent-spec.md'), 'utf8');

/** Every fenced code block of a markdown page: its info string's first word and its body. */
function fencedBlocks(markdown: string): { lang: string; body: string }[] {
  const blocks: { lang: string; body: string }[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)/.exec(lines[i]);
    if (open === null) continue;
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
    blocks.push({ lang: open[1], body: body.join('\n') });
  }
  return blocks;
}

/** The yaml fences whose document declares `version: 2` on its first line. */
function specYamlBlocks(markdown: string): string[] {
  return fencedBlocks(markdown)
    .filter((block) => block.lang === 'yaml' && /^version: 2\b/.test(block.body))
    .map((block) => block.body);
}

/** The `<file>.md` targets of the page's relative `./...` links. */
function relativeDocLinks(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(\.\/([A-Za-z0-9_-]+\.md)(#[^)]*)?\)/g)) {
    targets.push(match[1]);
  }
  return targets;
}

describe('docs/agent-spec.md', () => {
  it('has yaml examples, and every v2 one parses as AgentSpec v2', () => {
    const blocks = specYamlBlocks(page);
    expect(blocks.length).toBeGreaterThan(0);
    for (const body of blocks) {
      expect(() => parseAgentSpecV2(parseYaml(body)), body).not.toThrow();
    }
  });

  it('links only to docs pages that exist', () => {
    const targets = relativeDocLinks(page);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(path.join(docsDir, target)), `./${target}`).toBe(true);
    }
  });
});
