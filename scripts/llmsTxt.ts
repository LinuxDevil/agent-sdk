/**
 * Pure building blocks for scripts/generate-llms-txt.ts (LOU-D12).
 *
 * Everything here is string-in / string-out so it can be unit-tested without
 * touching the filesystem. Output is deterministic: stable ordering, `\n` line
 * endings and a single trailing newline, so `docs:llms:check` behaves the same
 * on Windows and Linux.
 */
import * as path from 'node:path';

/** A documentation page read from the repo (path is repo-relative, posix style). */
export interface DocPage {
  path: string;
  markdown: string;
}

/** An example directory with its README. */
export interface ExampleEntry {
  dir: string;
  readme: string;
}

export interface LlmsInput {
  name: string;
  repositoryUrl: string;
  readme: DocPage;
  docs: DocPage[];
  examples: ExampleEntry[];
}

/**
 * Pages listed under `## Optional` in llms.txt (everything else is under `## Docs`):
 * background reading and the legacy API, which an agent can skip when short on context.
 * Deployment and Agent Forge are first-class docs, so they are not here.
 */
const OPTIONAL_PAGES = new Set(['docs/prompting-techniques.md', 'docs/migrating-to-create-agent.md']);
/** Pages that always come first in llms-full.txt, in this order. */
const READING_ORDER = ['docs/installation.md', 'docs/quick-start.md', 'docs/api-overview.md'];
/** docs/*.md pages that are maintainer notes, not user documentation. */
const EXCLUDED_DOCS = new Set(['docs/eslint-baseline-followup.md']);

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** True for a repo-relative `docs/<name>.md` path that is meant for users. */
export function isUserDoc(repoPath: string): boolean {
  return /^docs\/[^/]+\.md$/.test(repoPath) && !EXCLUDED_DOCS.has(repoPath);
}

/** `git+https://github.com/o/r.git` -> `https://github.com/o/r`. */
export function repoBaseUrl(repositoryUrl: string): string {
  return repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/** Applies `fn` to the prose between fenced code blocks, leaving the fences untouched. */
function mapProse(markdown: string, fn: (prose: string) => string): string {
  return markdown
    .split(/(^```[\s\S]*?^```[^\n]*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

const BADGE_LINE = /^[ \t]*(\[?!\[[^\]]*\]\([^)]*\)(\]\([^)]*\))?[ \t]*)+$\n?/gm;

/** Drops HTML comments and badge-only lines (outside code fences). */
export function stripNoise(markdown: string): string {
  return mapProse(markdown, (prose) =>
    prose
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(BADGE_LINE, '')
      .replace(/\n{3,}/g, '\n\n'),
  );
}

/** The text of the first `# ` heading outside code fences. */
export function extractTitle(markdown: string): string {
  let title: string | undefined;
  mapProse(markdown, (prose) => {
    title ??= /^# +(.+?)\s*#*\s*$/m.exec(prose)?.[1];
    return prose;
  });
  if (!title) throw new Error('page has no top-level "# " heading');
  return title;
}

/** Removes the first `# ` heading line (llms-full.txt supplies its own header). */
export function removeTitle(markdown: string): string {
  let done = false;
  return mapProse(markdown, (prose) => {
    if (done) return prose;
    const next = prose.replace(/^# +.+\n?/m, '');
    done = next !== prose;
    return next;
  });
}

/** Markdown links and bold markers reduced to their plain text. */
function plainText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NON_PROSE_LINE = /^(#|```|\||>|[-*+] |\d+\. |\[.*\]\(.*\)\s*(&nbsp;)?\s*[·|]|---|<)/;

/** The first plain-prose paragraph (no headings, lists, tables, quotes or code), as one line. */
export function extractParagraph(markdown: string): string {
  const blocks = stripNoise(markdown)
    .split(/\n{2,}/)
    .map((block) => block.trim());
  const prose = blocks.find((block) => block && !NON_PROSE_LINE.test(block) && !block.includes('```'));
  return prose ? plainText(prose) : '';
}

/** The first sentence of `text` (or all of it, minus a trailing colon, when it has no full stop). */
export function firstSentence(text: string): string {
  return (splitSentences(text)[0] ?? text).replace(/:$/, '');
}

/**
 * Splits prose into sentences. A `.`, `!` or `?` ends a sentence only outside inline code and with
 * every bracket closed, so `{ name, preToolCall?, postToolCall? }` and `(see a.b. Then)` stay whole.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let depth = 0;
  let inCode = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') inCode = !inCode;
    else if (inCode) continue;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if ('.!?'.includes(ch) && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      sentences.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/** Longest description (in characters) llms.txt takes from a page's opening paragraph. */
const DESCRIPTION_MAX = 400;

/** Removes internal ticket ids such as `LOU-D12` (and a wrapping pair of parentheses). */
export function stripTicketIds(text: string): string {
  return text
    .replace(/ ?\(LOU-[A-Za-z0-9-]+(?:, [^)]*)?\)/g, '')
    .replace(/\bLOU-[A-Za-z]+\d*[a-z]?\b:? ?/g, '')
    .replace(/ {2,}/g, ' ');
}

/** The `description:` value of a leading `---` frontmatter block, if any. */
export function frontmatterDescription(markdown: string): string | undefined {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  const value = block ? /^description:\s*(.+)$/m.exec(block)?.[1] : undefined;
  return value?.trim().replace(/^(["'])(.*)\1$/, '$2');
}

/** Drops a leading `---` frontmatter block. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/**
 * A page's one-line description for llms.txt: the frontmatter `description`, else the opening
 * paragraph taken sentence by sentence (never mid-bracket) up to DESCRIPTION_MAX characters.
 */
export function describePage(markdown: string): string {
  const fromFrontmatter = frontmatterDescription(markdown);
  if (fromFrontmatter) return stripTicketIds(fromFrontmatter);
  let out = '';
  for (const sentence of splitSentences(extractParagraph(stripFrontmatter(markdown)))) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (out && next.length > DESCRIPTION_MAX) break;
    out = next;
  }
  return stripTicketIds(out.replace(/:$/, ''));
}

const ABSOLUTE_HREF = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Resolves a relative href against its source file into an absolute GitHub URL. */
export function absoluteHref(href: string, sourcePath: string, baseUrl: string): string {
  if (ABSOLUTE_HREF.test(href)) return href;
  const hashAt = href.indexOf('#');
  const file = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  if (!file) return href;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), file));
  const kind = file.endsWith('/') ? 'tree' : 'blob';
  return `${baseUrl}/${kind}/main/${resolved.replace(/\/$/, '')}${hash}`;
}

/** Rewrites relative markdown link/image targets (outside code fences) to absolute URLs. */
export function rewriteLinks(markdown: string, sourcePath: string, baseUrl: string): string {
  return mapProse(markdown, (prose) =>
    prose.replace(/(\]\()([^)\s]+)(\))/g, (_all, open: string, href: string, close: string) =>
      `${open}${absoluteHref(href, sourcePath, baseUrl)}${close}`,
    ),
  );
}

/** README/docs ordering for llms-full.txt: the fixed reading order first, then alphabetical. */
export function orderDocs<T extends { path: string }>(pages: T[]): T[] {
  const rank = (p: string): number => {
    const i = READING_ORDER.indexOf(p);
    return i === -1 ? READING_ORDER.length : i;
  };
  return [...pages].sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function pageUrl(baseUrl: string, repoPath: string): string {
  return `${baseUrl}/blob/main/${repoPath}`;
}

function entryLine(rawTitle: string, url: string, description: string): string {
  const title = stripTicketIds(rawTitle).trim();
  return description ? `- [${title}](${url}): ${description}` : `- [${title}](${url})`;
}

function docEntry(page: DocPage, baseUrl: string): string {
  const description = describePage(page.markdown);
  return entryLine(extractTitle(page.markdown), pageUrl(baseUrl, page.path), description);
}

function exampleEntry(example: ExampleEntry, baseUrl: string): string {
  const readmePath = `${example.dir}/README.md`;
  const description = describePage(example.readme);
  return entryLine(extractTitle(example.readme), pageUrl(baseUrl, readmePath), description);
}

function section(heading: string, lines: string[]): string[] {
  return lines.length ? [`## ${heading}`, '', ...lines, ''] : [];
}

/** llms.txt per the llmstxt.org convention. */
export function renderLlmsTxt(input: LlmsInput): string {
  const baseUrl = repoBaseUrl(input.repositoryUrl);
  const pages = [input.readme, ...orderDocs(input.docs)];
  const primary = pages.filter((p) => !OPTIONAL_PAGES.has(p.path)).map((p) => docEntry(p, baseUrl));
  const optional = pages.filter((p) => OPTIONAL_PAGES.has(p.path)).map((p) => docEntry(p, baseUrl));
  const examples = [...input.examples]
    .sort((a, b) => (a.dir < b.dir ? -1 : 1))
    .map((e) => exampleEntry(e, baseUrl));
  const lines = [
    `# ${input.name}`,
    '',
    `> ${stripTicketIds(extractParagraph(input.readme.markdown))}`,
    '',
    ...section('Docs', primary),
    ...section('Examples', examples),
    ...section('Optional', optional),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

function fullSection(page: DocPage, baseUrl: string): string {
  const body = removeTitle(rewriteLinks(stripNoise(stripFrontmatter(page.markdown)), page.path, baseUrl)).trim();
  return [`# ${extractTitle(page.markdown)}`, '', `Source: ${page.path}`, '', body].join('\n');
}

/** llms-full.txt: README first, then docs pages in reading order, each under its own header. */
export function renderLlmsFull(input: LlmsInput): string {
  const baseUrl = repoBaseUrl(input.repositoryUrl);
  const pages = [input.readme, ...orderDocs(input.docs)];
  return `${pages.map((p) => fullSection(p, baseUrl)).join('\n\n')}\n`;
}
