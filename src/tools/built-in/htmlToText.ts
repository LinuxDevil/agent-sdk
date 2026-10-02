/**
 * A small, dependency-free HTML-to-text converter for `web_fetch` (N13a).
 *
 * It is a single linear scan (no backtracking regular expressions over the
 * whole document), never executes or follows anything, and aims to be
 * readable rather than exact: `script`, `style`, `noscript`, `template`,
 * `svg` (and similar) are dropped with their content, block elements and
 * `<br>` become line breaks, link text keeps its URL in parentheses, common
 * named and all numeric entities are decoded, and whitespace is collapsed.
 */

const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'head']);

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html',
  'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', times: '×', divide: '÷',
  shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** Decodes named (common ones) and numeric character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[ref.toLowerCase()];
    return named ?? match;
  });
}

/** Index just past the `>` that closes the tag starting at `start`, honoring quoted attribute values. */
function tagEnd(html: string, start: number): number {
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return html.length;
}

/** The `href` attribute of a tag's source text, entity-decoded, or undefined. */
function hrefOf(tag: string): string | undefined {
  const match = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/** A link target worth showing: absolute http(s) or mailto, resolved against `baseUrl`. */
function displayUrl(href: string, baseUrl: string | undefined): string | undefined {
  if (!href || href.startsWith('#')) return undefined;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Collapses runs of spaces, trims each line and keeps at most one blank line in a row. */
function tidy(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/[ \t\f\v\r ]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}


/** Conversion state: the source, the output so far and the open links. */
interface State {
  html: string;
  lower: string;
  baseUrl: string | undefined;
  out: string[];
  links: Array<{ url: string | undefined; outIndex: number }>;
}

/** Elements whose end tag adds no blank line: they only start a line. */
const LINE_ITEMS = new Set(['li', 'td', 'th', 'dt', 'dd']);

function pushText(state: State, raw: string): void {
  if (raw) state.out.push(decodeEntities(raw.replace(/\s+/g, ' ')));
}

/** Skips a comment, doctype or processing instruction at `lt`; returns the index after it, or -1 when there is none. */
function skipMarkup(html: string, lt: number): number {
  if (html.startsWith('<!--', lt)) {
    const close = html.indexOf('-->', lt + 4);
    return close === -1 ? html.length : close + 3;
  }
  if (html[lt + 1] === '!' || html[lt + 1] === '?') return tagEnd(html, lt + 2);
  return -1;
}

/**
 * Skips a dropped element (`script`, `style`, ...) with its content and
 * returns the index after its end tag, or -1 when the element is kept. An
 * unclosed one runs to the end, except `<head>`, which would take the body
 * with it. A skipped `<head>` keeps its `<title>`.
 */
function skipElement(state: State, tagName: string, end: number, selfClosing: boolean): number {
  if (!SKIPPED.has(tagName) || selfClosing) return -1;
  const close = state.lower.indexOf(`</${tagName}`, end);
  if (close === -1) return tagName === 'head' ? -1 : state.html.length;
  if (tagName === 'head') {
    const title = /<title\b[^>]*>([^<]*)<\/title/i.exec(state.html.slice(end, close));
    if (title) state.out.push('\n', decodeEntities(title[1].replace(/\s+/g, ' ')), '\n');
  }
  return tagEnd(state.html, close + 2);
}

/** `<a href>` opens a link; `</a>` appends its URL after the link text. */
function handleLink(state: State, closing: boolean, selfClosing: boolean, tagSource: string): void {
  if (closing) {
    const link = state.links.pop();
    if (!link?.url) return;
    const text = state.out.slice(link.outIndex).join('').trim();
    if (text && text !== link.url) state.out.push(` (${link.url})`);
    return;
  }
  if (selfClosing) return;
  const href = hrefOf(tagSource);
  state.links.push({ url: href === undefined ? undefined : displayUrl(href, state.baseUrl), outIndex: state.out.length });
}

/** What a block element's start tag puts at the start of its line. */
function blockPrefix(tagName: string): string {
  if (tagName === 'li') return '- ';
  if (/^h[1-6]$/.test(tagName)) return '#'.repeat(Number(tagName[1])) + ' ';
  if (tagName === 'td' || tagName === 'th') return ' ';
  return '';
}

/** Handles the tag at `lt` and returns the index to continue from. */
function handleTag(state: State, lt: number): number {
  const { html } = state;
  const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
  if (!name) {
    // A '<' that does not start a tag is text.
    pushText(state, '<');
    return lt + 1;
  }
  const tagName = name[1].toLowerCase();
  const closing = html[lt + 1] === '/';
  const end = tagEnd(html, lt + 1);
  const selfClosing = html[end - 2] === '/';
  const skipped = closing ? -1 : skipElement(state, tagName, end, selfClosing);
  if (skipped !== -1) return skipped;

  if (tagName === 'br') state.out.push('\n');
  else if (tagName === 'a') handleLink(state, closing, selfClosing, html.slice(lt, end));
  else if (BLOCK.has(tagName) && !(closing && LINE_ITEMS.has(tagName))) state.out.push('\n', closing ? '' : blockPrefix(tagName));
  return end;
}

/**
 * Converts an HTML document to readable plain text. `baseUrl` resolves
 * relative link targets.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  const state: State = { html, lower: html.toLowerCase(), baseUrl, out: [], links: [] };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(state, html.slice(i));
      break;
    }
    pushText(state, html.slice(i, lt));
    const afterMarkup = skipMarkup(html, lt);
    i = afterMarkup !== -1 ? afterMarkup : handleTag(state, lt);
  }
  return tidy(state.out.join(''));
}
