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
      if (stopTypes.has(token.type)) {
        return nodes;
      }
      nodes.push(parseNode(token));
    }

    return nodes;
  }

  function parseNode(token: Token): BlockNode {
    if (token.type === 'open-if') {
      return { type: 'if', expr: token.expr, ...parseBlockBody('close-if', 'endif') };
    }
    if (token.type === 'open-for') {
      return { type: 'for', varName: token.varName, iterable: token.iterable, ...parseBlockBody('close-for', 'endfor') };
    }
    return parseLeafNode(token);
  }

  function parseLeafNode(token: Token): BlockNode {
    switch (token.type) {
      case 'text':
        pos++;
        return { type: 'text', value: token.value };

      case 'expression':
        pos++;
        return { type: 'expression', expr: token.expr };

      // A stray 'else' / 'close-if' / 'close-for' at this point has no
      // matching opener. Fail loudly instead of silently dropping the
      // tag and rendering incorrect output.
      default:
        throw new Error(
          `Unexpected closing tag with no matching open block: {% ${CLOSING_TAG_NAMES[token.type] ?? token.type} %}`
        );
    }
  }

  function parseElseBranch(closeType: 'close-if' | 'close-for'): BlockNode[] {
    if (tokens[pos]?.type !== 'else') {
      return [];
    }
    pos++; // consume else
    return parseNodes(new Set([closeType]));
  }

  /**
   * Consume the opening tag at the current position, then its children, an
   * optional {% else %} branch and the closing tag.
   */
  function parseBlockBody(
    closeType: 'close-if' | 'close-for',
    endTag: 'endif' | 'endfor'
  ): { children: BlockNode[]; elseChildren: BlockNode[] } {
    pos++; // consume opener
    const children = parseNodes(new Set(['else', closeType]));
    const elseChildren = parseElseBranch(closeType);
    if (tokens[pos]?.type !== closeType) {
      throw new Error(`Unclosed block: expected {% ${endTag} %}`);
    }
    pos++; // consume closer
    return { children, elseChildren };
  }

  return parseNodes(new Set());
}

const CLOSING_TAG_NAMES: Partial<Record<Token['type'], string>> = {
  else: 'else',
  'close-if': 'endif',
  'close-for': 'endfor',
};
