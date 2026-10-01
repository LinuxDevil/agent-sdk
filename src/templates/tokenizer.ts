/**
 * Tokenizer for TemplateManager's {% if %} / {% for %} / {{ expr }} syntax.
 *
 * This performs a single left-to-right scan of the template source and
 * produces a flat stream of tokens. It does not build any tree structure —
 * that is the job of parseTokens() in blockParser.ts (LOU-A9).
 *
 * In addition to the tags described in the ticket, this tokenizer also
 * recognizes `{% else %}`, because the existing template syntax (and its
 * test suite) supports `{% if %}...{% else %}...{% endif %}` and
 * `{% for %}...{% else %}...{% endfor %}`.
 */

export type Token =
  | { type: 'text'; value: string }
  | { type: 'open-if'; expr: string }
  | { type: 'open-for'; varName: string; iterable: string }
  | { type: 'else' }
  | { type: 'close-if' }
  | { type: 'close-for' }
  | { type: 'expression'; expr: string };

const IF_OPEN_RE = /^\{%\s*if\s+(.+?)\s*%\}/;
const FOR_OPEN_RE = /^\{%\s*for\s+(\w+)\s+in\s+(\w+(?:\.\w+)*)\s*%\}/;
const ELSE_RE = /^\{%\s*else\s*%\}/;
const ENDIF_RE = /^\{%\s*endif\s*%\}/;
const ENDFOR_RE = /^\{%\s*endfor\s*%\}/;
const EXPRESSION_RE = /^\{\{\s*(.*?)\s*\}\}/;

/**
 * Ordered tag rules. The first rule whose pattern matches at a tag boundary wins.
 */
const TAG_RULES: { re: RegExp; build: (m: RegExpExecArray) => Token }[] = [
  { re: IF_OPEN_RE, build: (m) => ({ type: 'open-if', expr: m[1] }) },
  { re: FOR_OPEN_RE, build: (m) => ({ type: 'open-for', varName: m[1], iterable: m[2] }) },
  { re: ENDIF_RE, build: () => ({ type: 'close-if' }) },
  { re: ENDFOR_RE, build: () => ({ type: 'close-for' }) },
  { re: ELSE_RE, build: () => ({ type: 'else' }) },
  { re: EXPRESSION_RE, build: (m) => ({ type: 'expression', expr: m[1] }) },
];

/** Only attempt tag matching at a {% or {{ boundary. */
function isTagBoundary(source: string, pos: number): boolean {
  return source[pos] === '{' && (source[pos + 1] === '%' || source[pos + 1] === '{');
}

/** Match a tag at the start of the source; returns the token and how many characters it consumed. */
function matchTag(remainder: string): { token: Token; length: number } | null {
  for (const rule of TAG_RULES) {
    const match = rule.re.exec(remainder);
    if (match) {
      return { token: rule.build(match), length: match[0].length };
    }
  }
  return null;
}

/**
 * Tokenize a template source string into a flat token stream.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) {
      tokens.push({ type: 'text', value: source.slice(textStart, end) });
    }
  };

  while (pos < source.length) {
    const tag = isTagBoundary(source, pos) ? matchTag(source.slice(pos)) : null;
    if (tag) {
      flushText(pos);
      tokens.push(tag.token);
      pos += tag.length;
      textStart = pos;
    } else {
      pos++;
    }
  }

  flushText(source.length);

  return tokens;
}
