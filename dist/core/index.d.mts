import { a as AgentType, k as AgentFlow, b as AgentConfig } from '../agent-VJBGMswO.mjs';
import { a as ToolConfiguration } from '../tool-DW-oM1Ru.mjs';
import 'ai';

/**
 * SDK Configuration
 */
interface SDKConfig {
    databaseIdHash: string;
    storageKey?: string;
    llm?: {
        provider: 'openai' | 'ollama' | string;
        apiKey?: string;
        model?: string;
        baseUrl?: string;
    };
    storage?: {
        provider: string;
        options?: Record<string, any>;
    };
    security?: {
        encryption?: boolean;
        encryptionKey?: string;
    };
}
/**
 * Configuration manager for SDK
 */
declare class ConfigManager {
    private config;
    constructor(config: SDKConfig);
    /**
     * Get configuration
     */
    getConfig(): SDKConfig;
    /**
     * Update configuration
     */
    updateConfig(updates: Partial<SDKConfig>): void;
    /**
     * Get specific config value
     */
    get<K extends keyof SDKConfig>(key: K): SDKConfig[K];
    /**
     * Validate configuration
     */
    private validate;
}

/**
 * Fluent API for building agents
 */
declare class AgentBuilder {
    private config;
    /**
     * Set agent type
     */
    setType(type: AgentType): this;
    /**
     * Set agent name
     */
    setName(name: string): this;
    /**
     * Set agent ID
     */
    setId(id: string): this;
    /**
     * Set system prompt
     */
    setPrompt(prompt: string): this;
    /**
     * Add a tool
     */
    addTool(key: string, config: ToolConfiguration): this;
    /**
     * Remove a tool
     */
    removeTool(key: string): this;
    /**
     * Set all tools
     */
    setTools(tools: Record<string, ToolConfiguration>): this;
    /**
     * Add a flow
     */
    addFlow(flow: AgentFlow): this;
    /**
     * Set all flows
     */
    setFlows(flows: AgentFlow[]): this;
    /**
     * Set expected result schema
     */
    setExpectedResult(schema: any): this;
    /**
     * Set locale
     */
    setLocale(locale: string): this;
    /**
     * Set events
     */
    setEvents(events: any[]): this;
    /**
     * Set settings
     */
    setSettings(settings: Record<string, any>): this;
    /**
     * Set metadata
     */
    setMetadata(metadata: Record<string, any>): this;
    /**
     * Build the agent configuration
     */
    build(): AgentConfig;
    /**
     * Validate configuration before building
     */
    private validate;
    /**
     * Load from existing config
     */
    static from(config: AgentConfig): AgentBuilder;
    /**
     * Create a new builder instance
     */
    static create(): AgentBuilder;
}

export { AgentBuilder, ConfigManager, type SDKConfig };
