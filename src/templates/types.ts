/**
 * Template types and interfaces
 */

/**
 * Filter function for template variables
 */
export type TemplateFilter = (arg: any) => string;

/**
 * Template rendering context
 */
export type TemplateContext = Record<string, any>;

/**
 * Template rendering options
 */
export interface TemplateOptions {
  /**
   * Custom filters for template variables
   */
  customFilters?: Record<string, TemplateFilter>;
  
  /**
   * Whether to escape HTML by default
   */
  autoEscape?: boolean;
}

/**
 * Template manager interface
 */
export interface ITemplateManager {
  /**
   * Render a template string with context
   */
  render(template: string, context: TemplateContext, options?: TemplateOptions): string;
  
  /**
   * Load and render a template file
   */
  renderFile?(filePath: string, context: TemplateContext, options?: TemplateOptions): Promise<string>;
}
