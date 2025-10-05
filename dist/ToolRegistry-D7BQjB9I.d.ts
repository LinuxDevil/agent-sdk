import { T as ToolDescriptor } from './tool-DW-oM1Ru.js';

/**
 * Tool Registry
 * Manages registration and retrieval of tools
 */
declare class ToolRegistry {
    private tools;
    /**
     * Register a tool
     */
    register(name: string, descriptor: ToolDescriptor): void;
    /**
     * Register multiple tools at once
     */
    registerMany(tools: Record<string, ToolDescriptor>): void;
    /**
     * Get a tool by name
     */
    get(name: string): ToolDescriptor | undefined;
    /**
     * Check if a tool exists
     */
    has(name: string): boolean;
    /**
     * Get all tool names
     */
    list(): string[];
    /**
     * Get all tools
     */
    getAll(): Record<string, ToolDescriptor>;
    /**
     * Remove a tool
     */
    unregister(name: string): boolean;
    /**
     * Clear all tools
     */
    clear(): void;
    /**
     * Get the number of registered tools
     */
    size(): number;
}
/**
 * Global tool registry instance
 */
declare const globalToolRegistry: ToolRegistry;

export { ToolRegistry as T, globalToolRegistry as g };
