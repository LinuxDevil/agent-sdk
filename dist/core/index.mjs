import { nanoid } from 'nanoid';

// src/core/ConfigManager.ts
var ConfigManager = class {
  config;
  constructor(config) {
    this.validate(config);
    this.config = config;
  }
  /**
   * Get configuration
   */
  getConfig() {
    return { ...this.config };
  }
  /**
   * Update configuration
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.validate(this.config);
  }
  /**
   * Get specific config value
   */
  get(key) {
    return this.config[key];
  }
  /**
   * Validate configuration
   */
  validate(config) {
    if (!config.databaseIdHash) {
      throw new Error("databaseIdHash is required in SDK configuration");
    }
  }
};

// src/types/agent.ts
var AgentType = /* @__PURE__ */ ((AgentType2) => {
  AgentType2["SmartAssistant"] = "smart-assistant";
  AgentType2["SurveyAgent"] = "survey-agent";
  AgentType2["CommerceAgent"] = "commerce-agent";
  AgentType2["Flow"] = "flow";
  return AgentType2;
})(AgentType || {});

// src/agent-types/validators.ts
function validateAgentConfig(config) {
  const errors = [];
  if (!config.name || config.name.trim() === "") {
    errors.push("Agent name is required");
  }
  if (!config.agentType) {
    errors.push("Agent type is required");
  }
  if (config.agentType && !Object.values(AgentType).includes(config.agentType)) {
    errors.push(`Invalid agent type: ${config.agentType}`);
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
function validateAgentTools(tools) {
  const errors = [];
  for (const [key, config] of Object.entries(tools)) {
    if (!config.tool) {
      errors.push(`Tool configuration for '${key}' is missing 'tool' property`);
    }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
var AgentBuilder = class _AgentBuilder {
  config = {};
  /**
   * Set agent type
   */
  setType(type) {
    this.config.agentType = type;
    return this;
  }
  /**
   * Set agent name
   */
  setName(name) {
    this.config.name = name;
    return this;
  }
  /**
   * Set agent ID
   */
  setId(id) {
    this.config.id = id;
    return this;
  }
  /**
   * Set system prompt
   */
  setPrompt(prompt) {
    this.config.prompt = prompt;
    return this;
  }
  /**
   * Add a tool
   */
  addTool(key, config) {
    if (!this.config.tools) {
      this.config.tools = {};
    }
    this.config.tools[key] = config;
    return this;
  }
  /**
   * Remove a tool
   */
  removeTool(key) {
    if (this.config.tools) {
      delete this.config.tools[key];
    }
    return this;
  }
  /**
   * Set all tools
   */
  setTools(tools) {
    this.config.tools = tools;
    return this;
  }
  /**
   * Add a flow
   */
  addFlow(flow) {
    if (!this.config.flows) {
      this.config.flows = [];
    }
    this.config.flows.push(flow);
    return this;
  }
  /**
   * Set all flows
   */
  setFlows(flows) {
    this.config.flows = flows;
    return this;
  }
  /**
   * Set expected result schema
   */
  setExpectedResult(schema) {
    this.config.expectedResult = schema;
    return this;
  }
  /**
   * Set locale
   */
  setLocale(locale) {
    this.config.locale = locale;
    return this;
  }
  /**
   * Set events
   */
  setEvents(events) {
    this.config.events = events;
    return this;
  }
  /**
   * Set settings
   */
  setSettings(settings) {
    this.config.settings = settings;
    return this;
  }
  /**
   * Set metadata
   */
  setMetadata(metadata) {
    this.config.metadata = metadata;
    return this;
  }
  /**
   * Build the agent configuration
   */
  build() {
    this.validate();
    return {
      id: this.config.id || nanoid(),
      name: this.config.name,
      agentType: this.config.agentType,
      locale: this.config.locale || "en",
      prompt: this.config.prompt,
      expectedResult: this.config.expectedResult,
      tools: this.config.tools || {},
      flows: this.config.flows || [],
      events: this.config.events || [],
      settings: this.config.settings || {},
      metadata: this.config.metadata || {}
    };
  }
  /**
   * Validate configuration before building
   */
  validate() {
    const validation = validateAgentConfig(this.config);
    if (!validation.valid) {
      throw new Error(`Agent configuration validation failed: ${validation.errors.join(", ")}`);
    }
    if (this.config.tools) {
      const toolsValidation = validateAgentTools(this.config.tools);
      if (!toolsValidation.valid) {
        throw new Error(`Agent tools validation failed: ${toolsValidation.errors.join(", ")}`);
      }
    }
  }
  /**
   * Load from existing config
   */
  static from(config) {
    const builder = new _AgentBuilder();
    builder.config = { ...config };
    return builder;
  }
  /**
   * Create a new builder instance
   */
  static create() {
    return new _AgentBuilder();
  }
};

export { AgentBuilder, ConfigManager };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map