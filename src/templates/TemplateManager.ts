/**
 * Template rendering engine
 * 
 * Supports Jinja2-like syntax:
 * - Variables: {{ variable }}, {{ variable|filter }}
 * - Conditionals: {% if condition %}...{% else %}...{% endif %}
 * - Loops: {% for item in items %}...{% else %}...{% endfor %}
 */

import { TemplateContext, TemplateFilter, TemplateOptions, ITemplateManager } from './types';
import { tokenize } from './tokenizer';
import { parseTokens, BlockNode } from './blockParser';

/**
 * Basic HTML-escaper used in the "|escape" (or "|e") filter.
 */
function escapeHtml(input: any): string {
  const str = String(input ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Retrieve a nested value from context by splitting on "."
 * e.g. getValueFromContext("user.name", { user: { name: "Alice" } }) -> "Alice"
 */
function getValueFromContext(varPath: string, context: any): any {
  return varPath.split('.').reduce((acc, key) => acc && acc[key], context);
}

/**
 * Evaluate the condition in {% if condition %}.
 * 
 * A very naive approach: if `conditionExpr` is a simple variable path,
 * we get its value from the context and do a truthy check.
 */
function evaluateCondition(conditionExpr: string, context: any): boolean {
  const value = getValueFromContext(conditionExpr, context);
  return !!value;
}

/**
 * Render a single {{ expr }} expression, including any "|filter" chain.
 *
 *    {{ var }}
 *    {{ var|escape }} or {{ var|e }}
 *    {{ var|someCustomFilter }}
 */
function renderExpression(
  expr: string,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  const parts = expr.split('|').map((p) => p.trim());
  const varPath = parts.shift() ?? '';

  const value = getValueFromContext(varPath, context) ?? '';

  return String(applyFilters(value, parts, filters));
}

/** Apply a chain of named filters to a value, skipping names that don't resolve to a function. */
function applyFilters(value: any, filterNames: string[], filters: Record<string, TemplateFilter>): any {
  let result = value;
  for (const filterName of filterNames) {
    const fn = resolveFilter(filterName, filters);
    if (typeof fn === 'function') {
      result = fn(result);
    }
  }
  return result;
}

function resolveFilter(
  filterName: string,
  filters: Record<string, TemplateFilter>
): TemplateFilter | undefined {
  // If user typed "|e", treat as "|escape"
  return filters[filterName] || (filterName === 'e' ? filters['escape'] : undefined);
}

type NodeRenderer<N extends BlockNode> = (
  node: N,
  context: any,
  filters: Record<string, TemplateFilter>
) => string;

const NODE_RENDERERS: { [K in BlockNode['type']]: NodeRenderer<Extract<BlockNode, { type: K }>> } = {
  text: (node) => node.value,
  expression: (node, context, filters) => renderExpression(node.expr, context, filters),
  if: renderIfBlock,
  for: renderForBlock,
};

/**
 * Walk a BlockNode tree (produced by parseTokens) and render it to a string.
 * Handles nested {% if %}/{% for %} blocks correctly, since each {% for %}
 * iteration gets its own extended context and adjacent for-blocks don't
 * share any mutable state.
 */
function renderBlockTree(
  nodes: BlockNode[],
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  let output = '';

  for (const node of nodes) {
    const render = NODE_RENDERERS[node.type] as NodeRenderer<BlockNode>;
    output += render(node, context, filters);
  }

  return output;
}

function renderIfBlock(
  node: Extract<BlockNode, { type: 'if' }>,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  const conditionResult = evaluateCondition(node.expr, context);
  return renderBlockTree(conditionResult ? node.children : node.elseChildren, context, filters);
}

/** Values a {% for %} loop iterates over: array elements, or the values of a plain object. */
function toLoopItems(iterable: any): any[] {
  if (Array.isArray(iterable)) {
    return iterable;
  }
  if (typeof iterable === 'object' && iterable !== null) {
    return Object.values(iterable);
  }
  return [];
}

function renderForBlock(
  node: Extract<BlockNode, { type: 'for' }>,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  const items = toLoopItems(getValueFromContext(node.iterable, context) || []);

  if (items.length === 0) {
    return renderBlockTree(node.elseChildren, context, filters);
  }

  let output = '';
  for (const item of items) {
    // Extend context with current item; each iteration gets its own
    // object, so adjacent for-blocks never leak state into one
    // another.
    const newContext = { ...context, [node.varName]: item };
    output += renderBlockTree(node.children, newContext, filters);
  }
  return output;
}

/**
 * Template manager implementation
 */
export class TemplateManager implements ITemplateManager {
  /**
   * Render a template string with context
   */
  render(template: string, context: TemplateContext, options?: TemplateOptions): string {
    // Merge built-in filters with custom filters
    const filters: Record<string, TemplateFilter> = {
      escape: escapeHtml,
      e: escapeHtml, // short alias
      ...(options?.customFilters || {}),
    };

    const tokens = tokenize(template);
    const tree = parseTokens(tokens);
    return renderBlockTree(tree, context, filters);
  }

  /**
   * Render template with a simple function interface
   */
  static renderTemplate(
    template: string,
    context: TemplateContext,
    customFilters: Record<string, TemplateFilter> = {}
  ): string {
    const manager = new TemplateManager();
    return manager.render(template, context, { customFilters });
  }
}

/**
 * Convenience function to render a template
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  customFilters: Record<string, TemplateFilter> = {}
): string {
  return TemplateManager.renderTemplate(template, context, customFilters);
}
