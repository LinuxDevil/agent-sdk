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

  let value = getValueFromContext(varPath, context) ?? '';

  for (const filterName of parts) {
    // If user typed "|e", treat as "|escape"
    const fn = filters[filterName] || (filterName === 'e' ? filters['escape'] : undefined);
    if (typeof fn === 'function') {
      value = fn(value);
    }
  }

  return String(value);
}

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
    switch (node.type) {
      case 'text':
        output += node.value;
        break;

      case 'expression':
        output += renderExpression(node.expr, context, filters);
        break;

      case 'if': {
        const conditionResult = evaluateCondition(node.expr, context);
        output += renderBlockTree(
          conditionResult ? node.children : node.elseChildren,
          context,
          filters
        );
        break;
      }

      case 'for': {
        const arr = getValueFromContext(node.iterable, context) || [];
        let items: any[] = [];
        if (Array.isArray(arr)) {
          items = arr;
        } else if (typeof arr === 'object' && arr !== null) {
          items = Object.values(arr);
        }

        if (items.length > 0) {
          for (const item of items) {
            // Extend context with current item; each iteration gets its own
            // object, so adjacent for-blocks never leak state into one
            // another.
            const newContext = { ...context, [node.varName]: item };
            output += renderBlockTree(node.children, newContext, filters);
          }
        } else {
          output += renderBlockTree(node.elseChildren, context, filters);
        }
        break;
      }
    }
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
