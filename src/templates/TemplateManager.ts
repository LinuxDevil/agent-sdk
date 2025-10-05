/**
 * Template rendering engine
 * 
 * Supports Jinja2-like syntax:
 * - Variables: {{ variable }}, {{ variable|filter }}
 * - Conditionals: {% if condition %}...{% else %}...{% endif %}
 * - Loops: {% for item in items %}...{% else %}...{% endfor %}
 */

import { TemplateContext, TemplateFilter, TemplateOptions, ITemplateManager } from './types';

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
 * Parse if-blocks of the form:
 * 
 *    {% if something %}
 *      ...
 *    {% else %}
 *      ...
 *    {% endif %}
 */
function parseIfBlocks(
  template: string,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  const ifBlockRegex = /{%\s*if\s+(.+?)\s*%}([\s\S]*?){%\s*endif\s*%}/;

  let match = ifBlockRegex.exec(template);
  while (match) {
    const [fullMatch, conditionExpr, blockContent] = match;

    // Check for optional {% else %} inside the blockContent
    let elseContent = '';
    let thenContent = blockContent;

    const elseRegex = /{%\s*else\s*%}([\s\S]*)$/;
    const elseMatch = elseRegex.exec(blockContent);
    if (elseMatch) {
      thenContent = blockContent.slice(0, elseMatch.index);
      elseContent = elseMatch[1];
    }

    // Evaluate condition
    const conditionResult = evaluateCondition(conditionExpr, context);

    // If condition is truthy, keep the "thenContent"
    // otherwise, keep the "elseContent"
    let chosenContent = conditionResult ? thenContent : elseContent;

    // Recursively parse nested if-blocks within the chosen content
    chosenContent = parseIfBlocks(chosenContent, context, filters);

    // Also parse nested for-blocks inside this chunk
    chosenContent = parseForBlocks(chosenContent, context, filters);

    // And do variable replacement
    chosenContent = replaceVariables(chosenContent, context, filters);

    // Replace the entire if-block in the template
    template =
      template.slice(0, match.index) +
      chosenContent +
      template.slice(match.index + fullMatch.length);

    match = ifBlockRegex.exec(template);
  }

  return template;
}

/**
 * Parse for-blocks of the form:
 * 
 *    {% for user in users %}
 *      ...
 *    {% else %}
 *      ...
 *    {% endfor %}
 */
function parseForBlocks(
  template: string,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  const forBlockRegex = /{%\s*for\s+(\w+)\s+in\s+(\w+(?:\.\w+)*)\s*%}([\s\S]*?){%\s*endfor\s*%}/;

  let match = forBlockRegex.exec(template);
  while (match) {
    const [fullMatch, itemVar, arrayVar, blockContent] = match;

    let elseContent = '';
    let innerContent = blockContent;

    // Check for optional {% else %} inside the blockContent
    const elseRegex = /{%\s*else\s*%}([\s\S]*)$/;
    const elseMatch = elseRegex.exec(blockContent);
    if (elseMatch) {
      innerContent = blockContent.slice(0, elseMatch.index);
      elseContent = elseMatch[1];
    }

    // Resolve array from context
    const arr = getValueFromContext(arrayVar, context) || [];
    let replacement = '';

    if (Array.isArray(arr) && arr.length > 0) {
      for (const item of arr) {
        // Extend context with current item
        const newContext = { ...context, [itemVar]: item };

        // Recursively parse if/for/variables in the loop content
        let parsed = innerContent;
        parsed = parseIfBlocks(parsed, newContext, filters);
        parsed = parseForBlocks(parsed, newContext, filters);
        parsed = replaceVariables(parsed, newContext, filters);

        replacement += parsed;
      }
    } else if (typeof arr === 'object' && Object.values(arr).length > 0) {
      for (const item of Object.values(arr)) {
        // Extend context with current item
        const newContext = { ...context, [itemVar]: item };

        // Recursively parse if/for/variables in the loop content
        let parsed = innerContent;
        parsed = parseIfBlocks(parsed, newContext, filters);
        parsed = parseForBlocks(parsed, newContext, filters);
        parsed = replaceVariables(parsed, newContext, filters);

        replacement += parsed;
      }
    } else {
      // If array is empty, parse the else block
      let parsedElse = elseContent;
      parsedElse = parseIfBlocks(parsedElse, context, filters);
      parsedElse = parseForBlocks(parsedElse, context, filters);
      parsedElse = replaceVariables(parsedElse, context, filters);
      replacement = parsedElse;
    }

    // Replace entire block with the loop expansion
    template =
      template.slice(0, match.index) +
      replacement +
      template.slice(match.index + fullMatch.length);

    match = forBlockRegex.exec(template);
  }

  return template;
}

/**
 * Replace variable placeholders of the form:
 * 
 *    {{ var }}
 *    {{ var|escape }} or {{ var|e }}
 *    {{ var|someCustomFilter }}
 */
function replaceVariables(
  template: string,
  context: any,
  filters: Record<string, TemplateFilter>
): string {
  return template.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    // e.g., "user.name|escape"
    const parts = expr.split('|').map((p: string) => p.trim());
    const varPath = parts.shift() ?? '';

    let value = getValueFromContext(varPath, context) ?? '';

    // Apply each filter if exists
    for (const filterName of parts) {
      // If user typed "|e", treat as "|escape"
      const fn =
        filters[filterName] || (filterName === 'e' ? filters['escape'] : undefined);
      if (typeof fn === 'function') {
        value = fn(value);
      }
    }

    return String(value);
  });
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

    // 1) Parse {% if %}
    template = parseIfBlocks(template, context, filters);

    // 2) Parse {% for %}
    template = parseForBlocks(template, context, filters);

    // 3) Finally, replace {{ var }} placeholders
    template = replaceVariables(template, context, filters);

    return template;
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
