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
    // Only attempt tag matching at a `{%` or `{{` boundary.
    if (source[pos] === '{' && (source[pos + 1] === '%' || source[pos + 1] === '{')) {
      const remainder = source.slice(pos);

      const ifMatch = IF_OPEN_RE.exec(remainder);
      if (ifMatch) {
        flushText(pos);
        tokens.push({ type: 'open-if', expr: ifMatch[1] });
        pos += ifMatch[0].length;
        textStart = pos;
        continue;
      }

      const forMatch = FOR_OPEN_RE.exec(remainder);
      if (forMatch) {
        flushText(pos);
        tokens.push({ type: 'open-for', varName: forMatch[1], iterable: forMatch[2] });
        pos += forMatch[0].length;
        textStart = pos;
        continue;
      }

      const endifMatch = ENDIF_RE.exec(remainder);
      if (endifMatch) {
        flushText(pos);
        tokens.push({ type: 'close-if' });
        pos += endifMatch[0].length;
        textStart = pos;
        continue;
      }

      const endforMatch = ENDFOR_RE.exec(remainder);
      if (endforMatch) {
        flushText(pos);
        tokens.push({ type: 'close-for' });
        pos += endforMatch[0].length;
        textStart = pos;
        continue;
      }

      const elseMatch = ELSE_RE.exec(remainder);
      if (elseMatch) {
        flushText(pos);
        tokens.push({ type: 'else' });
        pos += elseMatch[0].length;
        textStart = pos;
        continue;
      }

      const exprMatch = EXPRESSION_RE.exec(remainder);
      if (exprMatch) {
        flushText(pos);
        tokens.push({ type: 'expression', expr: exprMatch[1] });
        pos += exprMatch[0].length;
        textStart = pos;
        continue;
      }
    }

    pos++;
  }

  flushText(source.length);

  return tokens;
}
