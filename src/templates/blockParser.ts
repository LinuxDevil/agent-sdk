/**
 * Recursive-descent parser that turns a flat Token stream (see tokenizer.ts)
 * into a tree of BlockNode, so nested {% if %}/{% for %} blocks render
 * correctly and unbalanced tags fail fast instead of silently producing
 * wrong output.
 */

import { Token } from './tokenizer';

export type BlockNode =
  | { type: 'text'; value: string }
  | { type: 'if'; expr: string; children: BlockNode[]; elseChildren: BlockNode[] }
  | { type: 'for'; varName: string; iterable: string; children: BlockNode[]; elseChildren: BlockNode[] }
  | { type: 'expression'; expr: string };

/**
 * Parse a flat token stream into a tree of BlockNode.
 *
 * Throws `Unclosed block: expected {% end<if|for> %}` if an {% if %} or
 * {% for %} is opened but the token stream ends before its matching close
 * tag (and, for {% if %}, its optional {% else %}) is found.
 */
export function parseTokens(tokens: Token[]): BlockNode[] {
  let pos = 0;

  function parseNodes(stopTypes: ReadonlySet<Token['type']>): BlockNode[] {
    const nodes: BlockNode[] = [];

    while (pos < tokens.length) {
      const token = tokens[pos];
      const tokenType = token.type;
      if (stopTypes.has(tokenType)) {
        return nodes;
      }

      switch (token.type) {
        case 'text':
          nodes.push({ type: 'text', value: token.value });
          pos++;
          break;

        case 'expression':
          nodes.push({ type: 'expression', expr: token.expr });
          pos++;
          break;

        case 'open-if': {
          const { expr } = token;
          pos++; // consume open-if
          const children = parseNodes(new Set(['else', 'close-if']));
          let elseChildren: BlockNode[] = [];
          if (tokens[pos]?.type === 'else') {
            pos++; // consume else
            elseChildren = parseNodes(new Set(['close-if']));
          }
          if (tokens[pos]?.type !== 'close-if') {
            throw new Error('Unclosed block: expected {% endif %}');
          }
          pos++; // consume close-if
          nodes.push({ type: 'if', expr, children, elseChildren });
          break;
        }

        case 'open-for': {
          const { varName, iterable } = token;
          pos++; // consume open-for
          const children = parseNodes(new Set(['else', 'close-for']));
          let elseChildren: BlockNode[] = [];
          if (tokens[pos]?.type === 'else') {
            pos++; // consume else
            elseChildren = parseNodes(new Set(['close-for']));
          }
          if (tokens[pos]?.type !== 'close-for') {
            throw new Error('Unclosed block: expected {% endfor %}');
          }
          pos++; // consume close-for
          nodes.push({ type: 'for', varName, iterable, children, elseChildren });
          break;
        }

        // A stray 'else' / 'close-if' / 'close-for' at this point has no
        // matching opener. Fail loudly instead of silently dropping the
        // tag and rendering incorrect output.
        default:
          throw new Error(
            `Unexpected closing tag with no matching open block: {% ${tokenType === 'else' ? 'else' : tokenType === 'close-if' ? 'endif' : tokenType === 'close-for' ? 'endfor' : tokenType} %}`
          );
      }
    }

    return nodes;
  }

  return parseNodes(new Set());
}
