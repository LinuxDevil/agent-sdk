/**
 * Loads the SDK's own docs (read-only) and splits them into heading-scoped chunks.
 * Paths are stored repo-relative with `/` separators (e.g. `docs/evals.md`) so
 * nothing machine-specific leaks into tool results, prompts or cassettes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCS_DIR = path.join(REPO_ROOT, 'docs');

export interface Chunk {
  id: string;
  /** Repo-relative, `/`-separated, e.g. `docs/evals.md`. */
  file: string;
  /** Heading path, e.g. `Evals > Record, replay and drift`. */
  heading: string;
  /** The last heading only (what a citation should name). */
  section: string;
  text: string;
}

const MAX_CHARS = 1600;

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('__') || entry.name === 'node_modules') continue;
      out.push(...listMarkdown(full));
    } else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/** Split one section body into <= MAX_CHARS pieces on paragraph boundaries. */
function splitBody(body: string): string[] {
  if (body.length <= MAX_CHARS) return [body];
  const pieces: string[] = [];
  let current = '';
  for (const para of body.split(/\n{2,}/)) {
    if (current && current.length + para.length + 2 > MAX_CHARS) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > MAX_CHARS * 1.5) {
      pieces.push(current.slice(0, MAX_CHARS));
      current = current.slice(MAX_CHARS);
    }
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

export function chunkFile(file: string, markdown: string): Chunk[] {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let body: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = body.join('\n').trim();
    body = [];
    if (text.length < 40) return;
    const heading = stack.filter(Boolean).join(' > ') || rel;
    const section = stack.filter(Boolean).at(-1) ?? rel;
    for (const [i, piece] of splitBody(text).entries()) {
      chunks.push({ id: `${rel}#${chunks.length}${i ? `.${i}` : ''}`, file: rel, heading, section, text: piece });
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = m[2].trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return chunks;
}

export function loadCorpus(): Chunk[] {
  return listMarkdown(DOCS_DIR).flatMap((file) => chunkFile(file, fs.readFileSync(file, 'utf8')));
}

/** Every (file, section) pair that exists in the corpus, for citation validation. */
export function sectionIndex(chunks: readonly Chunk[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const c of chunks) {
    const set = map.get(c.file) ?? new Set<string>();
    set.add(c.section.toLowerCase());
    map.set(c.file, set);
  }
  return map;
}
