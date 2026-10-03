import { ToolDescriptor } from '../types';
import { DefinedTool, isDefinedTool } from './defineTool';
import { isHostedTool } from './hosted';
import { toolEntries, type ToolsOption } from './toolEntries';
import { ConfigurationError } from '../execution/errors';

/**
 * Tool Registry
 * Manages registration and retrieval of tools
 */
export class ToolRegistry {
  private tools: Map<string, ToolDescriptor> = new Map();

  /**
   * Register a tool defined with `defineTool()` under its own name. Throws if
   * a tool with that name is already registered.
   *
   * @example
   * registry.register(sendEmail);
   */
  public register(tool: DefinedTool): void;
  /**
   * Register a tool descriptor under an explicit name. Re-registering a name
   * overwrites the previous entry (with a warning).
   */
  public register(name: string, descriptor: ToolDescriptor): void;
  public register(nameOrTool: string | DefinedTool, descriptor?: ToolDescriptor): void {
    if (typeof nameOrTool !== 'string') {
      this.registerDefined(nameOrTool);
      return;
    }
    if (!descriptor) {
      throw new ConfigurationError(
        `ToolRegistry.register('${nameOrTool}'): a descriptor is required. ` +
          `Pass one (register('${nameOrTool}', descriptor)) or register a defineTool() result directly.`, 'tools');
    }
    if (this.tools.has(nameOrTool)) {
      console.warn(`Tool '${nameOrTool}' is already registered. Overwriting.`);
    }
    this.tools.set(nameOrTool, descriptor);
  }

  private registerDefined(tool: DefinedTool): void {
    if (!isDefinedTool(tool)) {
      throw new ConfigurationError(
        'ToolRegistry.register(tool): expected a tool created with defineTool(). ' +
          'For a raw descriptor pass a name: register(name, descriptor).', 'tools');
    }
    const existing = this.tools.get(tool.name);
    if (existing) {
      const describe = (t: ToolDescriptor) => `"${t.displayName}"`;
      throw new ConfigurationError(
        `Tool name '${tool.name}' is already registered: existing tool ${describe(existing)} ` +
          `conflicts with new tool ${describe(tool)}. Give one of them a different name.`, 'tools');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once: a record of descriptors keyed by name,
   * or an array of `defineTool()` results, named descriptors (such as the
   * tools `connectMcp()` loads) and records of them, mixed (LOU-R12).
   */
  public registerMany(tools: ToolsOption): void {
    for (const [name, tool] of toolEntries(tools, 'ToolRegistry.registerMany')) {
      if (isHostedTool(tool)) {
        throw new ConfigurationError(
          `ToolRegistry.registerMany: '${name}' is a hosted tool (${tool.type}) - ` +
            'hosted tools run on the provider and cannot be registered; pass them in createAgent({ tools }) instead.',
          'tools'
        );
      }
      if (isDefinedTool(tool) && tool.name === name) {
        this.registerDefined(tool);
      } else {
        this.register(name, tool);
      }
    }
  }

  /**
   * Get a tool by name
   */
  public get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all tool names
   */
  public list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tools
   */
  public getAll(): Record<string, ToolDescriptor> {
    const result: Record<string, ToolDescriptor> = {};
    this.tools.forEach((descriptor, name) => {
      result[name] = descriptor;
    });
    return result;
  }

  /**
   * Remove a tool
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Clear all tools
   */
  public clear(): void {
    this.tools.clear();
  }

  /**
   * Get the number of registered tools
   */
  public size(): number {
    return this.tools.size;
  }
}

/**
 * Global tool registry instance
 */
export const globalToolRegistry = new ToolRegistry();
