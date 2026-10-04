import { AgentConfig, AgentSettings, ToolConfiguration } from '../types';
import { AgentFlow } from '../types/flow';
import { newId } from '../utils/id';
import type { DefinedTool } from '../tools/defineTool';
import { SDKError } from '../execution/errors';

/**
 * Fluent API for building agents
 */
export class AgentBuilder {
  private config: Partial<AgentConfig> = {};

  /**
   * Set agent name
   */
  public setName(name: string): this {
    this.config.name = name;
    return this;
  }

  /**
   * Set agent ID
   */
  public setId(id: string): this {
    this.config.id = id;
    return this;
  }

  /**
   * Set system prompt
   */
  public setPrompt(prompt: string): this {
    this.config.prompt = prompt;
    return this;
  }

  /**
   * Add a tool: either a `defineTool()` result (keyed by its name; register
   * the same tool with a ToolRegistry for execution) or an explicit
   * key + configuration.
   */
  public addTool(tool: DefinedTool): this;
  public addTool(key: string, config: ToolConfiguration): this;
  public addTool(keyOrTool: string | DefinedTool, config?: ToolConfiguration): this {
    if (!this.config.tools) {
      this.config.tools = {};
    }
    if (typeof keyOrTool === 'string') {
      if (!config) {
        throw new SDKError(
          `AgentBuilder.addTool('${keyOrTool}'): a configuration is required. ` +
            `Example: addTool('${keyOrTool}', { tool: '${keyOrTool}' }), or pass a defineTool() result.`,
          'LOUSHO_CONFIG_INVALID'
        );
      }
      this.config.tools[keyOrTool] = config;
    } else {
      this.config.tools[keyOrTool.name] = { tool: keyOrTool.name, description: keyOrTool.description };
    }
    return this;
  }

  /**
   * Remove a tool
   */
  public removeTool(key: string): this {
    if (this.config.tools) {
      delete this.config.tools[key];
    }
    return this;
  }

  /**
   * Set all tools
   */
  public setTools(tools: Record<string, ToolConfiguration>): this {
    this.config.tools = tools;
    return this;
  }

  /**
   * Add a flow
   */
  public addFlow(flow: AgentFlow): this {
    if (!this.config.flows) {
      this.config.flows = [];
    }
    this.config.flows.push(flow);
    return this;
  }

  /**
   * Set all flows
   */
  public setFlows(flows: AgentFlow[]): this {
    this.config.flows = flows;
    return this;
  }

  /**
   * Set expected result schema
   */
  public setExpectedResult(schema: unknown): this {
    this.config.expectedResult = schema;
    return this;
  }

  /**
   * Set locale
   */
  public setLocale(locale: string): this {
    this.config.locale = locale;
    return this;
  }

  /**
   * Set events
   */
  public setEvents(events: unknown[]): this {
    this.config.events = events;
    return this;
  }

  /**
   * Set settings
   */
  public setSettings(settings: AgentSettings): this {
    this.config.settings = settings;
    return this;
  }

  /**
   * Set metadata
   */
  public setMetadata(metadata: Record<string, unknown>): this {
    this.config.metadata = metadata;
    return this;
  }

  /**
   * Build the agent configuration
   */
  public build(): AgentConfig {
    this.validate();
    
    return {
      id: this.config.id || newId(),
      name: this.config.name!,
      locale: this.config.locale || 'en',
      prompt: this.config.prompt,
      expectedResult: this.config.expectedResult,
      tools: this.config.tools || {},
      flows: this.config.flows || [],
      events: this.config.events || [],
      settings: this.config.settings || {},
      metadata: this.config.metadata || {},
    };
  }

  /**
   * Validate configuration before building
   */
  private validate(): void {
    if (!this.config.name || this.config.name.trim() === '') {
      throw new SDKError(
        `Agent configuration validation failed: Agent name is required. ` +
          `Example: AgentBuilder.create().setName('my-agent')...build()`,
        'LOUSHO_VALIDATION_FAILED'
      );
    }

    if (this.config.tools) {
      const toolErrors = Object.entries(this.config.tools)
        .filter(([, config]) => !config.tool)
        .map(([key]) => `Tool configuration for '${key}' is missing 'tool' property`);
      if (toolErrors.length > 0) {
        throw new SDKError(`Agent tools validation failed: ${toolErrors.join(', ')}`, 'LOUSHO_VALIDATION_FAILED');
      }
    }
  }

  /**
   * Load from existing config
   */
  public static from(config: AgentConfig): AgentBuilder {
    const builder = new AgentBuilder();
    builder.config = { ...config };
    return builder;
  }

  /**
   * Create a new builder instance
   */
  public static create(): AgentBuilder {
    return new AgentBuilder();
  }
}
