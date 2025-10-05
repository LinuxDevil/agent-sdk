import { AgentConfig, AgentType, ToolConfiguration, AgentFlow } from '../types';
import { validateAgentConfig, validateAgentTools } from '../agent-types';
import { nanoid } from 'nanoid';

/**
 * Fluent API for building agents
 */
export class AgentBuilder {
  private config: Partial<AgentConfig> = {};

  /**
   * Set agent type
   */
  public setType(type: AgentType): this {
    this.config.agentType = type;
    return this;
  }

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
   * Add a tool
   */
  public addTool(key: string, config: ToolConfiguration): this {
    if (!this.config.tools) {
      this.config.tools = {};
    }
    this.config.tools[key] = config;
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
  public setExpectedResult(schema: any): this {
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
  public setEvents(events: any[]): this {
    this.config.events = events;
    return this;
  }

  /**
   * Set settings
   */
  public setSettings(settings: Record<string, any>): this {
    this.config.settings = settings;
    return this;
  }

  /**
   * Set metadata
   */
  public setMetadata(metadata: Record<string, any>): this {
    this.config.metadata = metadata;
    return this;
  }

  /**
   * Build the agent configuration
   */
  public build(): AgentConfig {
    this.validate();
    
    return {
      id: this.config.id || nanoid(),
      name: this.config.name!,
      agentType: this.config.agentType!,
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
    const validation = validateAgentConfig(this.config);
    if (!validation.valid) {
      throw new Error(`Agent configuration validation failed: ${validation.errors.join(', ')}`);
    }

    if (this.config.tools) {
      const toolsValidation = validateAgentTools(this.config.tools);
      if (!toolsValidation.valid) {
        throw new Error(`Agent tools validation failed: ${toolsValidation.errors.join(', ')}`);
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
