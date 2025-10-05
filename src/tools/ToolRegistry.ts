import { ToolDescriptor } from '../types';

/**
 * Tool Registry
 * Manages registration and retrieval of tools
 */
export class ToolRegistry {
  private tools: Map<string, ToolDescriptor> = new Map();

  /**
   * Register a tool
   */
  public register(name: string, descriptor: ToolDescriptor): void {
    if (this.tools.has(name)) {
      console.warn(`Tool '${name}' is already registered. Overwriting.`);
    }
    this.tools.set(name, descriptor);
  }

  /**
   * Register multiple tools at once
   */
  public registerMany(tools: Record<string, ToolDescriptor>): void {
    Object.entries(tools).forEach(([name, descriptor]) => {
      this.register(name, descriptor);
    });
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
