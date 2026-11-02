/**
 * The `searchDocs` tool's index over the bundled SDK docs
 * (`<package root>/docs/*.md`): files split on `## ` headings into
 * sections, scored per query as `3 × heading hits + body hits` over the
 * query's words (lowercased, length ≥ 2, stop-words removed), and served
 * as `{ title, path, excerpt }` hits.
 *
 * The index is cached after the first load - the docs ship inside the
 * package, so they cannot change under a running Studio, and the read is
 * a dozen small files done once per server lifetime (per docsDir, so a
 * test's fixture folder gets its own entry).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One `## ` section of a docs file (the preamble before the first `## ` is a section too, with `heading === ''`). */
export interface DocSection {
  /** The file name, e.g. `'handoffs.md'`. */
  file: string;
  /** The file's `# ` title (the file basename without `.md` when it has none). */
  fileTitle: string;
  /** The `## ` heading text, or `''` for the preamble section. */
  heading: string;
  /** The section's lines after its heading. */
  body: string;
  /** `docs/<file>#<github-style slug of the heading>` - the deep link the Author quotes. */
  path: string;
}

/** The parsed docs folder. */
export interface DocsIndex {
  sections: DocSection[];
}

/** One `searchDocs` hit. */
export interface DocHit {
  /** `<file H1> › <section heading>` (just the file title for a preamble hit). */
  title: string;
  path: string;
  /** ≤ 300 chars of body around the first hit, trimmed to word boundaries with `…` where cut. */
  excerpt: string;
}

/** Query words that never score - noise every docs page carries. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in']);

/** One `loadDocsIndex` promise per docsDir: the index builds once. */
const cache = new Map<string, Promise<DocsIndex | undefined>>();

/**
 * The docs folder's index, or `undefined` when the folder is missing or
 * unreadable (the tool turns that into `UNAVAILABLE` - Studio must work
 * without bundled docs). Cached after the first call per `docsDir`.
 */
export function loadDocsIndex(docsDir: string): Promise<DocsIndex | undefined> {
  const cached = cache.get(docsDir);
  if (cached !== undefined) return cached;
  const loaded = readDocsDir(docsDir).catch(() => undefined);
  cache.set(docsDir, loaded);
  return loaded;
}

/** The best-matching sections: score > 0, sorted by score desc then path, capped at `limit`. */
export function searchDocs(index: DocsIndex, query: string, limit: number): DocHit[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return index.sections
    .map((section) => ({ section, score: scoreSection(section, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.section.path.localeCompare(b.section.path))
    .slice(0, Math.max(limit, 1))
    .map(({ section }) => ({
      title: section.heading === '' ? section.fileTitle : `${section.fileTitle} › ${section.heading}`,
      path: section.path,
      excerpt: excerptFor(section.body, words),
    }));
}

// ---------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------

/** Reads `<docsDir>/*.md` into sections; throws when the folder cannot be listed (the caller normalizes to `undefined`). */
async function readDocsDir(docsDir: string): Promise<DocsIndex> {
  const files = (await fs.promises.readdir(docsDir)).filter((file) => file.endsWith('.md')).sort((a, b) => a.localeCompare(b));
  const sections: DocSection[] = [];
  for (const file of files) {
    const raw = await fs.promises.readFile(path.join(docsDir, file), 'utf8');
    sections.push(...splitSections(file, raw));
  }
  return { sections };
}

/** The GitHub-style anchor slug of a heading: lowercased, punctuation stripped, spaces to dashes. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** One file's sections: a preamble (heading `''`, path slugged from the H1) plus one per `## ` line. */
function splitSections(file: string, raw: string): DocSection[] {
  const lines = raw.split('\n');
  const fileTitle = lines.find((line) => line.startsWith('# '))?.slice(2).trim() || file.replace(/\.md$/, '');
  const sections: DocSection[] = [];
  let heading = '';
  let body: string[] = [];
  const flush = (): void => {
    sections.push({ file, fileTitle, heading, body: body.join('\n'), path: `docs/${file}#${slug(heading === '' ? fileTitle : heading)}` });
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      heading = line.slice(3).trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------
// Scoring and excerpts
// ---------------------------------------------------------------------

/** Σ over query words of `3 × hits in heading + hits in body` (case-insensitive substring counts). */
function scoreSection(section: DocSection, words: string[]): number {
  const heading = section.heading.toLowerCase();
  const body = section.body.toLowerCase();
  let score = 0;
  for (const word of words) {
    score += 3 * countHits(heading, word) + countHits(body, word);
  }
  return score;
}

/** Non-overlapping occurrences of `needle` in `text`. */
function countHits(text: string, needle: string): number {
  let hits = 0;
  let at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) {
    hits += 1;
    at += needle.length;
  }
  return hits;
}

/**
 * The excerpt of `body`: ≤ 300 chars starting ~80 before the first query
 * hit, trimmed to word boundaries, `…` marking each cut end. A section
 * that only matched its heading excerpts from the body's start.
 */
function excerptFor(body: string, words: string[]): string {
  const lower = body.toLowerCase();
  const firstHit = words.reduce((earliest, word) => {
    const at = lower.indexOf(word);
    return at !== -1 && at < earliest ? at : earliest;
  }, Number.POSITIVE_INFINITY);
  let start = firstHit === Number.POSITIVE_INFINITY ? 0 : Math.max(0, firstHit - 80);
  if (start > 0) {
    // Advance to a word boundary: never open mid-word.
    while (start < body.length && /\w/.test(body[start - 1])) start += 1;
    while (start < body.length && /\s/.test(body[start])) start += 1;
  }
  let end = Math.min(body.length, start + 300);
  if (end < body.length) {
    // Back off to a word boundary: never cut a word in half.
    while (end > start && /\w/.test(body[end - 1]) && /\w/.test(body[end])) end -= 1;
  }
  const text = body.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${text}${end < body.length ? '…' : ''}`;
}
