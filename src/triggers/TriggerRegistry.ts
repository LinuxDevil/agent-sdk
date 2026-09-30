import { TriggerAdapter } from './types';

/**
 * Trigger Registry (LOU-T5)
 *
 * Manages registration and retrieval of TriggerAdapters. Deliberately
 * mirrors ToolRegistry's API shape (src/tools/ToolRegistry.ts) 1:1 -
 * register/registerMany/get/has/list/getAll/unregister/clear/size - so
 * that "ways an agent can be woken up" has the same discoverability and
 * ergonomics as "things an agent can do".
 */
export class TriggerRegistry {
  private adapters: Map<string, TriggerAdapter> = new Map();

  /**
   * Register a trigger adapter under `name`. Like ToolRegistry.register(),
   * registering the same name twice overwrites (with a warning) rather
   * than throwing.
   */
  public register(name: string, adapter: TriggerAdapter): void {
    if (this.adapters.has(name)) {
      console.warn(`Trigger adapter '${name}' is already registered. Overwriting.`);
    }
    this.adapters.set(name, adapter);
  }

  /**
   * Register multiple trigger adapters at once.
   */
  public registerMany(adapters: Record<string, TriggerAdapter>): void {
    Object.entries(adapters).forEach(([name, adapter]) => {
      this.register(name, adapter);
    });
  }

  /**
   * Get a trigger adapter by name.
   */
  public get(name: string): TriggerAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Check if a trigger adapter is registered under `name`.
   */
  public has(name: string): boolean {
    return this.adapters.has(name);
  }

  /**
   * Get all registered adapter names.
   */
  public list(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all registered trigger adapters.
   */
  public getAll(): Record<string, TriggerAdapter> {
    const result: Record<string, TriggerAdapter> = {};
    this.adapters.forEach((adapter, name) => {
      result[name] = adapter;
    });
    return result;
  }

  /**
   * Remove a trigger adapter.
   */
  public unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  /**
   * Clear all registered trigger adapters.
   */
  public clear(): void {
    this.adapters.clear();
  }

  /**
   * Number of registered trigger adapters.
   */
  public size(): number {
    return this.adapters.size;
  }
}

/**
 * Global trigger registry instance, mirroring `globalToolRegistry`.
 */
export const globalTriggerRegistry = new TriggerRegistry();
