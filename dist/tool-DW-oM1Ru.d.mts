import { Tool } from 'ai';

/**
 * Tool parameter definition
 */
interface ToolParameter {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
}
/**
 * Tool parameters schema
 */
interface ToolParameters {
    type: string;
    properties: Record<string, ToolParameter>;
    required: string[];
}
/**
 * Tool configuration for agents
 */
interface ToolConfiguration {
    tool: string;
    description?: string;
    options?: Record<string, any>;
}
/**
 * Tool descriptor with display name
 */
interface ToolDescriptor {
    displayName: string;
    tool: Tool;
    injectStreamingController?: (controller: ReadableStreamDefaultController<unknown>) => void;
}
/**
 * Tool registry interface
 */
interface IToolRegistry {
    register(name: string, descriptor: ToolDescriptor): void;
    get(name: string): ToolDescriptor | undefined;
    has(name: string): boolean;
    list(): string[];
    clear(): void;
}

export type { IToolRegistry as I, ToolDescriptor as T, ToolConfiguration as a, ToolParameter as b, ToolParameters as c };
